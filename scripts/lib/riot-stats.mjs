// Aggregates Riot match-v5 games into the META / COUNTERS format of data.json.
// Pure functions (no network), so the maths can be tested on hand-made matches.
//
// Only totals are kept: champion games, wins, bans, lane matchups (game won, lane dominated), bot-lane duos,
// wins by game length, keystone runes and summoner spells. No player id is stored.
const POSITION_ROLE = { BOTTOM: "adc", UTILITY: "sup" };
const ROLES = ["adc", "sup"];

export function newTally() {
  const role = () => ({ games: {}, wins: {}, vs: {}, len: {}, lane: {}, kit: {} });
  return { matches: 0, bans: {}, adc: role(), sup: role(), duos: {}, pos: {} };
}

// Games shorter than SHORT seconds show early strength, longer than LONG late strength.
export const SHORT = 25 * 60, LONG = 30 * 60;

// Tallies cached before duos and game length were counted get the missing (empty) totals.
export function upgradeTally(t) {
  t.duos ??= {};
  t.pos ??= {}; // champion -> { n: games in any role, adc, sup }: share of its bans that belongs to the role
  for (const r of ROLES) { t[r].len ??= {}; t[r].lane ??= {}; t[r].kit ??= {}; }
  return t;
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
  upgradeTally(tally);
  tally.matches++;
  const bucket = info.gameDuration < SHORT ? "s" : info.gameDuration > LONG ? "l" : null;
  const banned = new Set();
  for (const t of info.teams ?? []) for (const b of t.bans ?? []) { const id = idOf(b.championId); if (id) banned.add(id); }
  banned.forEach(id => inc(tally.bans, id));
  for (const p of info.participants) {
    const id = idOf(p.championId); if (!id) continue;
    const c = (tally.pos[id] ??= { n: 0, adc: 0, sup: 0 });
    c.n++; const r = POSITION_ROLE[p.teamPosition]; if (r) c[r]++;
  }
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
      const v = t.vs[me][foe];
      v.g++; if (p.win) v.w++;
      // Lane dominated = Riot's challenges.laningPhaseGoldExpAdvantage (0 or 1, missing in some games):
      // a clear gold and experience lead at the end of the laning phase. It is set in about a quarter
      // of ADC lanes only (neither laner has it in the others), so it is NOT "lane won".
      const lw = p.challenges?.laningPhaseGoldExpAdvantage;
      if (lw === 0 || lw === 1) {
        v.ln = (v.ln ?? 0) + 1; v.lw = (v.lw ?? 0) + lw;
        const l = (t.lane[me] ??= [0, 0]); l[0]++; l[1] += lw;
      }
      // Keystone rune and summoner spells (pair in a fixed order)
      const k = (t.kit[me] ??= { k: {}, s: {} });
      const ks = p.perks?.styles?.[0]?.selections?.[0]?.perk;
      if (ks) { const e = (k.k[ks] ??= [0, 0]); e[0]++; if (p.win) e[1]++; }
      if (p.summoner1Id && p.summoner2Id) {
        const sp = [p.summoner1Id, p.summoner2Id].sort((a, b) => a - b).join("|");
        const e = (k.s[sp] ??= [0, 0]); e[0]++; if (p.win) e[1]++;
      }
      if (bucket) { t.len[me] ??= { s: [0, 0], l: [0, 0] }; t.len[me][bucket][0]++; if (p.win) t.len[me][bucket][1]++; }
    }
  }
  // Bot-lane duos (ADC + support of the same team). A duo with a seed player in it is left out.
  for (const team of [100, 200]) {
    const a = info.participants.find(p => p.teamId === team && p.teamPosition === "BOTTOM");
    const s = info.participants.find(p => p.teamId === team && p.teamPosition === "UTILITY");
    if (!a || !s || skip(a.puuid) || skip(s.puuid)) continue;
    const ia = idOf(a.championId), is = idOf(s.championId); if (!ia || !is) continue;
    const d = (tally.duos[`${ia}|${is}`] ??= { g: 0, w: 0 });
    d.g++; if (a.win) d.w++;
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
  // 400 virtual games at 50 %: a champion played 134 times at 63 % (one-tricks) does not outrank Jinx at 1 900 games.
  const prior = opts.prior ?? 400;
  const N = Math.max(1, tally.matches);
  upgradeTally(tally);
  const minDuo = opts.minDuo ?? 20, minPhase = opts.minPhase ?? 40;
  const META = {}, COUNTERS = {}, MATCHUPS = {}, PHASES = {}, STATS = {}, LANE_WINS = {}, KITS = {};
  for (const role of ROLES) {
    const t = tally[role];
    // Games in which this lane was counted (seed lanes are left out): 2 champions per counted lane.
    const lanes = Math.max(1, Object.values(t.games).reduce((a, b) => a + b, 0) / 2);
    const kept = Object.keys(t.games).filter(id => t.games[id] >= Math.max(minGames, minPickRate * lanes));
    // Bans are not tied to a role: a Viktor banned for mid must not push the ADC Viktor up. They count
    // in proportion to the games the champion plays in this role (unknown for older caches: not counted).
    const roleBans = id => { const c = tally.pos[id]; return c?.n ? (tally.bans[id] ?? 0) * c[role] / c.n : null; };
    const presence = id => t.games[id] / lanes + (roleBans(id) ?? 0) / N;
    const ranked = opts.ranked?.[role];
    const scored = kept.filter(id => !ranked || ranked.has(id));
    const med = median(scored.map(presence)) || 1;
    // Strength = winrate (shrunk) + how often the champion is picked or banned, relative to the role.
    const entries = scored.map(id => ({
      id, strength: 100 * (shrunk(t.wins[id] ?? 0, t.games[id], prior) - 0.5) + 2 * Math.log(presence(id) / med),
    }));
    const scores = percentileScores(entries);
    META[role] = {}; COUNTERS[role] = {}; STATS[role] = {};
    for (const { id } of entries.sort((a, b) => scores[b.id] - scores[a.id])) {
      const g = t.games[id], w = t.wins[id] ?? 0;
      META[role][id] = [round2(scores[id]), round2((100 * w) / g)];
      const b = roleBans(id);
      STATS[role][id] = [g, round2((100 * g) / lanes), b === null ? null : round2((100 * b) / N)]; // games, pick %, ban % in this role
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
    // Lane results of the ranked champions: { id: { foe: [games, wins of id] } }, enough games only.
    MATCHUPS[role] = {};
    for (const id of Object.keys(META[role])) {
      const rows = Object.entries(t.vs[id] ?? {}).filter(([foe, m]) => foe !== id && m.g >= minMatchup).sort((a, b) => b[1].g - a[1].g);
      // [games, wins] or, when the lane result is known in enough games,
      // [games, wins, lanes, lanes dominated by id, lanes dominated by foe]
      if (rows.length) MATCHUPS[role][id] = Object.fromEntries(rows.map(([foe, m]) => [foe, (m.ln ?? 0) >= minMatchup
        ? [m.g, m.w, m.ln, m.lw ?? 0, Math.min(m.ln, t.vs[foe]?.[id]?.lw ?? 0)] : [m.g, m.w]]));
    }
    // Lanes overall: [lanes, lanes dominated, lanes dominated by the opponent]; keystones and summoner
    // pairs: top picks with [id, games, wins].
    LANE_WINS[role] = {}; KITS[role] = {};
    const top = (o, n) => Object.entries(o).filter(([, [g]]) => g >= minPhase).sort((a, b) => b[1][0] - a[1][0]).slice(0, n).map(([k, [g, w]]) => [k, g, w]);
    for (const id of Object.keys(META[role])) {
      const l = t.lane[id];
      if (l && l[0] >= minPhase) {
        // lanes the opponents dominated against id, in the lanes where the result is known
        const conceded = Object.entries(t.vs).reduce((a, [foe, row]) => a + (foe !== id && row[id]?.ln ? row[id].lw ?? 0 : 0), 0);
        LANE_WINS[role][id] = [l[0], l[1], Math.min(l[0], conceded)];
      }
      const k = t.kit[id]; if (!k) continue;
      const runes = top(k.k, 3).map(([kk, g, w]) => [Number(kk), g, w]), spells = top(k.s, 2);
      // n = games whose keystone is known (counted since 01/10/2026), for the share of each pick
      const n = Object.values(k.k).reduce((a, [g]) => a + g, 0);
      if (runes.length || spells.length) KITS[role][id] = { n, runes, spells };
    }
    // Wins in short and long games: [short games, short wins, long games, long wins].
    PHASES[role] = {};
    for (const id of Object.keys(META[role])) {
      const l = t.len[id];
      if (l && l.s[0] >= minPhase && l.l[0] >= minPhase) PHASES[role][id] = [l.s[0], l.s[1], l.l[0], l.l[1]];
    }
  }
  // Duos of champions the app proposes, with enough games: { "Adc|Sup": [games, wins] }.
  const DUO_STATS = Object.fromEntries(Object.entries(tally.duos)
    .filter(([k, d]) => { const [a, s] = k.split("|"); return d.g >= minDuo && META.adc[a] && META.sup[s]; })
    .sort((x, y) => y[1].g - x[1].g).map(([k, d]) => [k, [d.g, d.w]]));
  return { META, COUNTERS, STATS, MATCHUPS, PHASES, LANE_WINS, KITS, DUO_STATS, matches: tally.matches };
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round2 = x => Math.round(x * 100) / 100;
