// Aggregates Riot match-v5 games into the META / COUNTERS format of data.json.
// Pure functions (no network), so the maths can be tested on hand-made matches.
//
// Only totals are kept: champion games, wins, bans and lane matchups. No player id is stored.
const POSITION_ROLE = { BOTTOM: "adc", UTILITY: "sup" };
const ROLES = ["adc", "sup"];

export function newTally() {
  const role = () => ({ games: {}, wins: {}, vs: {} });
  return { matches: 0, bans: {}, adc: role(), sup: role() };
}

const inc = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };

// A game counts when it is a finished ranked game of the wanted patch (remakes are skipped).
export function isUsable(info, gameVersionPrefix) {
  return info?.queueId === 420 && String(info.gameVersion ?? "").startsWith(gameVersionPrefix)
    && (info.gameDuration ?? 0) >= 300 && !info.participants?.some(p => p.gameEndedInEarlySurrender);
}

// idOf: numeric championId -> Data Dragon id ("MissFortune"), or undefined when unknown.
// skip(puuid): true for the players the games were found through. They are picked high on the
// ladder, so they win more than average: their lane (them and their lane opponent) is left out,
// otherwise their champions look too strong and their opponents too weak.
export function addMatch(tally, info, idOf, skip = () => false) {
  tally.matches++;
  const banned = new Set();
  for (const t of info.teams ?? []) for (const b of t.bans ?? []) { const id = idOf(b.championId); if (id) banned.add(id); }
  banned.forEach(id => inc(tally.bans, id));
  for (const [pos, role] of Object.entries(POSITION_ROLE)) {
    const side = info.participants.filter(p => p.teamPosition === pos);
    if (side.length !== 2 || side[0].teamId === side[1].teamId) continue;
    if (side.some(p => skip(p.puuid))) continue;
    const t = tally[role];
    for (const p of side) {
      const me = idOf(p.championId); if (!me) continue;
      inc(t.games, me); if (p.win) inc(t.wins, me);
      const foe = idOf(side.find(x => x !== p).championId); if (!foe) continue;
      t.vs[me] ??= {}; t.vs[me][foe] ??= { g: 0, w: 0 };
      t.vs[me][foe].g++; if (p.win) t.vs[me][foe].w++;
    }
  }
}

// Winrate pulled toward 50 % by `prior` virtual games, so small samples do not dominate.
const shrunk = (w, g, prior) => (w + prior / 2) / (g + prior);

function percentileScores(entries) {
  // Rank inside the role mapped onto the app's scale (36 = bottom, 67 = top; see tierLabel).
  const sorted = [...entries].sort((a, b) => b.strength - a.strength);
  const n = sorted.length;
  return Object.fromEntries(sorted.map((e, i) => [e.id, n === 1 ? 67 : 67 - (31 * i) / (n - 1)]));
}

// opts.ranked: { adc: Set, sup: Set } = champions the app can propose. Only they get a tier score
// (an off-role Syndra bot would shift the scale); the others still count as lane opponents.
export function computeStats(tally, opts = {}) {
  const minPickRate = opts.minPickRate ?? 0.005, minGames = opts.minGames ?? 20;
  const minMatchup = opts.minMatchup ?? 15, maxCounters = opts.maxCounters ?? 3;
  const N = Math.max(1, tally.matches);
  const META = {}, COUNTERS = {}, details = {};
  for (const role of ROLES) {
    const t = tally[role];
    const kept = Object.keys(t.games).filter(id => t.games[id] >= Math.max(minGames, minPickRate * N));
    const presence = id => (t.games[id] + (tally.bans[id] ?? 0)) / N;
    const ranked = opts.ranked?.[role];
    const scored = kept.filter(id => !ranked || ranked.has(id));
    const med = median(scored.map(presence)) || 1;
    // Strength = winrate (shrunk) + how often the champion is picked or banned, relative to the role.
    const entries = scored.map(id => ({
      id, strength: 100 * (shrunk(t.wins[id] ?? 0, t.games[id], 100) - 0.5) + 2 * Math.log(presence(id) / med),
    }));
    const scores = percentileScores(entries);
    META[role] = {}; COUNTERS[role] = {}; details[role] = {};
    for (const { id } of entries.sort((a, b) => scores[b.id] - scores[a.id])) {
      const g = t.games[id], w = t.wins[id] ?? 0;
      META[role][id] = [round2(scores[id]), round2((100 * w) / g)];
      details[role][id] = { games: g, pick: round2((100 * g) / N), ban: round2((100 * (tally.bans[id] ?? 0)) / N) };
    }
    // Counters of every kept champion (an enemy Syndra bot has counters too): the kept champions that
    // beat it in lane, with enough games to trust it.
    for (const id of [...Object.keys(META[role]), ...kept.filter(id => !META[role][id])]) {
      COUNTERS[role][id] = Object.entries(t.vs[id] ?? {})
        .filter(([foe, m]) => foe !== id && kept.includes(foe) && m.g >= minMatchup)
        .map(([foe, m]) => [foe, 1 - shrunk(m.w, m.g, 20)]) // the foe's winrate against `id`
        .filter(([, wr]) => wr > 0.52)
        .sort((a, b) => b[1] - a[1]).slice(0, maxCounters).map(([foe]) => foe);
    }
  }
  return { META, COUNTERS, details, matches: tally.matches };
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round2 = x => Math.round(x * 100) / 100;
