// Stats source: our own stats, computed from ranked games of the official Riot API (match-v5).
// Needs a Riot personal API key (never logged): env STATS_API_KEY, or the file ~/.config/botlane-draft/riot-key.
//
// Games are added up across runs: the totals of the patch and the ids of the games already read
// are kept in .stats-cache/ (local, not committed). A new patch starts a new file.
// Ctrl+C stops the collection early: the games read so far are kept and the stats computed.
//
// Settings (env, all optional):
//   RIOT_PLATFORM      euw1          server whose ranked ladder is sampled
//   RIOT_REGION        europe        match-v5 routing value of that server
//   RIOT_TIERS         EMERALD,DIAMOND,MASTER,GRANDMASTER,CHALLENGER
//   RIOT_PAGES         3             ladder pages read per tier/division (about 205 players each)
//   RIOT_RATE          20:1,100:120  app rate limits of the key ("count:seconds", comma separated)
//   STATS_MAX_MINUTES  300           collection time budget of this run (a GitHub job stops at 6 h)
//   STATS_MAX_MATCHES  30000         stop this run once it has added this many games
//   STATS_MIN_MATCHES  500           below this total, the run fails instead of publishing noise
//   STATS_CACHE_DIR    .stats-cache  where the running totals are kept ("" = no cache)
//
// Riot policies followed: aggregate stats only (no player shown or stored), 429 answers honoured.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { newTally, addMatch, isUsable, computeStats, upgradeTally } from "../lib/riot-stats.mjs";
import { patchToGameVersion } from "../lib/patch.mjs";

export const info = { name: "API Riot", scope: "EUW Émeraude+" };

const DIVISIONS = { EMERALD: ["I", "II", "III", "IV"], DIAMOND: ["I", "II", "III", "IV"], MASTER: ["I"], GRANDMASTER: ["I"], CHALLENGER: ["I"] };
const TIER_FR = { EMERALD: "Émeraude", DIAMOND: "Diamant", MASTER: "Maître", GRANDMASTER: "Grand Maître", CHALLENGER: "Challenger" };
const DEFAULT_CACHE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".stats-cache");
const KEY_FILE = join(homedir(), ".config", "botlane-draft", "riot-key");

export async function fetchStats({ patch, champions, previous, env, log = console.log, fetchImpl = fetch, now = Date.now, signals = process }) {
  const key = readKey(env);
  const platform = env.RIOT_PLATFORM || "euw1", region = env.RIOT_REGION || "europe";
  const tiers = (env.RIOT_TIERS || "EMERALD,DIAMOND,MASTER,GRANDMASTER,CHALLENGER").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  for (const t of tiers) if (!DIVISIONS[t]) throw new Error(`RIOT_TIERS : rang inconnu "${t}"`);
  const deadline = now() + Number(env.STATS_MAX_MINUTES || 300) * 60_000;
  const maxMatches = Number(env.STATS_MAX_MATCHES || 30000);
  const gv = patchToGameVersion(patch);
  const api = client({ key, limits: parseLimits(env.RIOT_RATE || "20:1,100:120"), fetchImpl, now, log });
  const idOf = await championIds(fetchImpl, champions);

  const cache = openCache(env.STATS_CACHE_DIR ?? DEFAULT_CACHE, { patch, platform, tiers }, now, log);
  const { tally, seen } = cache;
  const startMatches = tally.matches;
  let stopped = false;
  const onInt = () => { stopped = true; log("Arrêt demandé : calcul des stats avec les parties déjà lues…"); };
  signals.once?.("SIGINT", onInt);
  const done = () => stopped || now() > deadline || tally.matches - startMatches >= maxMatches;

  try {
    // Players: the first pages of each tier/division, shuffled so a short run still mixes the ranks.
    const pages = Math.max(1, Number(env.RIOT_PAGES || 3));
    const buckets = shuffle(tiers.flatMap(t => DIVISIONS[t].flatMap(d => Array.from({ length: pages }, (_, i) => [t, d, i + 1]))));
    const players = [];
    for (const [t, d, page] of buckets) {
      if (done()) break;
      const entries = await api.get(`https://${platform}.api.riotgames.com/lol/league-exp/v4/entries/RANKED_SOLO_5x5/${t}/${d}?page=${page}`);
      for (const e of entries ?? []) if (e.puuid) players.push(e.puuid);
    }
    const seeds = new Set(players); // a player seen on two pages counts once
    players.splice(0, players.length, ...seeds);
    shuffle(players);
    log(`${players.length} joueurs classés trouvés (${tiers.map(t => TIER_FR[t]).join(", ")}), patch ${patch}` +
      (startMatches ? `, ${startMatches} parties déjà cumulées` : ""));

    // Games of the last 3 weeks, kept only when they were played on the wanted patch. Riot does not
    // publish the patch date: every game of an older patch moves `since` past its start, so the next
    // match lists only hold games of the current patch.
    let requests = 0, lastLog = tally.matches, lastSave = tally.matches;
    outer: for (const puuid of players) {
      if (done()) break;
      const ids = await api.get(`https://${region}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&type=ranked&startTime=${cache.since}&count=20`);
      requests++;
      for (const id of ids ?? []) {
        if (seen.has(id)) continue;
        if (done()) break outer;
        const m = await api.get(`https://${region}.api.riotgames.com/lol/match/v5/matches/${id}`);
        requests++;
        seen.add(id);
        if (m && isUsable(m.info, gv)) addMatch(tally, m.info, idOf, p => seeds.has(p));
        else if (m && isOlder(m.info?.gameVersion, gv) && m.info.gameCreation) cache.since = Math.max(cache.since, Math.floor(m.info.gameCreation / 1000));
        if (tally.matches - lastLog >= 500) { lastLog = tally.matches; log(`${tally.matches} parties cumulées (${requests} requêtes ce lancement)`); }
        if (tally.matches - lastSave >= 200) { lastSave = tally.matches; cache.save(); }
      }
    }
  } finally {
    signals.removeListener?.("SIGINT", onInt);
    cache.save();
  }
  log(`Collecte terminée : ${tally.matches - startMatches} parties ajoutées, ${tally.matches} au total pour le patch ${patch}.`);
  const minMatches = Number(env.STATS_MIN_MATCHES || 500);
  if (tally.matches < minMatches) throw new Error(`seulement ${tally.matches} parties du patch ${patch} : pas assez pour des stats fiables (relance pour en ajouter)`);

  const ranked = previous?.ADC && previous?.SUP ? { adc: new Set(Object.keys(previous.ADC)), sup: new Set(Object.keys(previous.SUP)) } : undefined;
  const stats = computeStats(tally, { ranked });
  for (const r of ["adc", "sup"]) {
    const off = Object.keys(tally[r].games).filter(id => !stats.META[r][id] && tally[r].games[id] >= 0.005 * tally.matches);
    if (off.length) log(`${r.toUpperCase()} joués mais sans profil dans l'appli (pas classés) : ${off.join(", ")}`);
  }
  const lowest = Object.keys(DIVISIONS).find(t => tiers.includes(t));
  const server = platform.replace(/\d+$/, "").toUpperCase();
  // Duos and game length are only counted since 01/10/2026: an older cache has none yet (omitted).
  const optional = Object.fromEntries([["MATCHUPS", stats.MATCHUPS], ["PHASES", stats.PHASES], ["DUO_STATS", stats.DUO_STATS]]
    .filter(([, v]) => Object.values(v).some(x => typeof x !== "object" || Object.keys(x).length)));
  return { patch, META: stats.META, COUNTERS: stats.COUNTERS, ...optional, scope: `${server} ${TIER_FR[lowest]}+, ${tally.matches.toLocaleString("fr-FR")} parties` };
}

function readKey(env) {
  let key = (env.STATS_API_KEY ?? "").trim();
  if (!key && env.STATS_API_KEY === undefined && existsSync(KEY_FILE)) key = readFileSync(KEY_FILE, "utf8").trim();
  if (!key) throw new Error(`clé API Riot absente : mets-la dans ${KEY_FILE} (en local) ou dans le secret STATS_API_KEY (GitHub)`);
  return key;
}

// Running totals of one patch / server / ranks. dir "" = in memory only.
// CACHE_VERSION changes when the way games are counted changes: older totals are then dropped.
const CACHE_VERSION = 2;
export function openCache(dir, scope, now, log) {
  const name = `riot-${scope.patch}-${scope.platform}-${[...scope.tiers].sort().join("+").toLowerCase()}.json`;
  const file = dir ? join(dir, name) : null;
  let state = null;
  if (file && existsSync(file)) {
    try { state = JSON.parse(readFileSync(file, "utf8")); }
    catch { log(`Cache illisible (${name}) : on repart de zéro.`); }
  }
  if (state && state.version !== CACHE_VERSION) log(`Cache d'une ancienne méthode de calcul (${name}) : on repart de zéro.`);
  const cache = {
    tally: state?.version === CACHE_VERSION ? upgradeTally(state.tally) : newTally(),
    seen: new Set(state?.version === CACHE_VERSION ? state.seen : []),
    since: state?.version === CACHE_VERSION ? state.since : Math.floor(now() / 1000) - 21 * 86400,
    save() {
      if (!file) return;
      mkdirSync(dir, { recursive: true });
      // Older patches are useless once a new one is cached.
      for (const f of readdirSync(dir)) if (f.startsWith("riot-") && f !== name && !f.startsWith(`riot-${scope.patch}-`)) rmSync(join(dir, f));
      writeFileSync(file + ".tmp", JSON.stringify({ version: CACHE_VERSION, ...scope, since: cache.since, tally: cache.tally, seen: [...cache.seen] }));
      renameSync(file + ".tmp", file);
    },
  };
  return cache;
}

// "16.18.1.1" is older than prefix "16.19."
export function isOlder(version, prefix) {
  const v = String(version ?? "").split(".").map(Number), p = prefix.split(".").map(Number);
  return v[0] < p[0] || (v[0] === p[0] && v[1] < p[1]);
}

// numeric championId -> Data Dragon id, restricted to the champions the app knows.
async function championIds(fetchImpl, champions) {
  const versions = await (await fetchImpl("https://ddragon.leagueoflegends.com/api/versions.json")).json();
  const res = await fetchImpl(`https://ddragon.leagueoflegends.com/cdn/${versions[0]}/data/en_US/champion.json`);
  if (!res.ok) throw new Error(`Data Dragon champion.json : HTTP ${res.status}`);
  const byKey = Object.fromEntries(Object.values((await res.json()).data).map(c => [Number(c.key), c.id]));
  return num => { const id = byKey[num]; return id && champions.ids.has(id) ? id : undefined; };
}

export function parseLimits(spec) {
  return spec.split(",").map(s => {
    const [count, seconds] = s.split(":").map(Number);
    if (!(count > 0 && seconds > 0)) throw new Error(`RIOT_RATE invalide : "${spec}"`);
    return { count, ms: seconds * 1000 };
  });
}

// HTTP client that stays under every app limit (sliding windows) and waits on 429.
export function client({ key, limits, fetchImpl, now, log, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const sent = [];
  async function slot() {
    for (;;) {
      const t = now();
      let wait = 0;
      for (const l of limits) {
        const inWindow = sent.filter(x => x > t - l.ms);
        if (inWindow.length >= l.count) wait = Math.max(wait, inWindow[inWindow.length - l.count] + l.ms - t + 50);
      }
      if (wait <= 0) { sent.push(t); const keep = Math.max(...limits.map(l => l.ms)); while (sent.length && sent[0] <= t - keep) sent.shift(); return; }
      await sleep(wait);
    }
  }
  return {
    async get(url) {
      for (let attempt = 0; attempt < 6; attempt++) {
        await slot();
        let res;
        try { res = await fetchImpl(url, { headers: { "X-Riot-Token": key } }); }
        catch (e) { await sleep(2000 * (attempt + 1)); continue; } // network hiccup
        if (res.ok) return res.json();
        if (res.status === 404) return null;
        if (res.status === 401 || res.status === 403) throw new Error(`clé API Riot refusée (HTTP ${res.status}) : clé expirée ou invalide ?`);
        if (res.status === 429) {
          const s = Number(res.headers.get("retry-after")) || 10;
          log(`Limite de requêtes atteinte, pause de ${s} s`);
          await sleep(s * 1000);
          continue;
        }
        if (res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
        throw new Error(`API Riot : HTTP ${res.status} sur ${label(url)}`);
      }
      throw new Error(`API Riot : trop d'échecs sur ${label(url)}`);
    },
  };
}

// URL without query nor player/match id, safe for public Action logs.
const label = url => url.replace(/\?.*/, "").replace(/by-puuid\/[^/]+/, "by-puuid/…").replace(/matches\/[A-Z0-9]+_\d+/, "matches/…");

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
