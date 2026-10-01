import { test } from "node:test";
import assert from "node:assert/strict";
import { newTally, addMatch, isUsable, computeStats } from "../lib/riot-stats.mjs";
import { patchToGameVersion } from "../lib/patch.mjs";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchStats, client, parseLimits, isOlder } from "../sources/riot.mjs";

const IDS = { 1: "Jinx", 2: "Caitlyn", 3: "Lux", 4: "Thresh", 5: "Garen", 6: "Ashe", 7: "Nami" };
const idOf = n => IDS[n];
const P = (teamId, teamPosition, championId, win) => ({ teamId, teamPosition, championId, win, gameEndedInEarlySurrender: false });
// Jinx+Lux (blue) vs Caitlyn+Thresh (red); `blueWins` decides the game.
function game(blueWins, { adc = [1, 2], sup = [3, 4], version = "16.19.823.722", bans = [[5], [6]] } = {}) {
  return { queueId: 420, gameVersion: version, gameDuration: 1800,
    teams: [{ bans: bans[0].map(championId => ({ championId })) }, { bans: bans[1].map(championId => ({ championId })) }],
    participants: [P(100, "TOP", 5, blueWins), P(100, "BOTTOM", adc[0], blueWins), P(100, "UTILITY", sup[0], blueWins),
      P(200, "TOP", 7, !blueWins), P(200, "BOTTOM", adc[1], !blueWins), P(200, "UTILITY", sup[1], !blueWins)] };
}

test("patch name maps to the match-v5 game version", () => {
  assert.equal(patchToGameVersion("26.19"), "16.19.");
  assert.equal(patchToGameVersion("25.1"), "15.1.");
  assert.throws(() => patchToGameVersion("14.24"));
});

test("older patch detection", () => {
  assert.ok(isOlder("16.18.9.1", "16.19."));
  assert.ok(isOlder("15.24.1.1", "16.1."));
  assert.ok(!isOlder("16.19.1.1", "16.19."));
  assert.ok(!isOlder("16.20.1.1", "16.19."));
  assert.ok(isOlder("16.9.1.1", "16.19."), "numeric, not text, comparison");
});

test("only finished ranked games of the patch are usable", () => {
  const g = game(true);
  assert.ok(isUsable(g, "16.19."));
  assert.ok(!isUsable({ ...g, gameVersion: "16.18.1.1" }, "16.19."));
  assert.ok(!isUsable({ ...g, gameVersion: "16.1.1.1" }, "16.19."), "16.1 is not 16.19");
  assert.ok(!isUsable({ ...g, queueId: 440 }, "16.19."));
  assert.ok(!isUsable({ ...g, gameDuration: 200 }, "16.19."));
  assert.ok(!isUsable({ ...g, participants: g.participants.map((p, i) => ({ ...p, gameEndedInEarlySurrender: i === 0 })) }, "16.19."));
});

test("tally counts games, wins, bans and lane matchups", () => {
  const t = newTally();
  addMatch(t, game(true), idOf); addMatch(t, game(true), idOf); addMatch(t, game(false), idOf);
  assert.equal(t.matches, 3);
  assert.deepEqual([t.adc.games.Jinx, t.adc.wins.Jinx, t.adc.wins.Caitlyn], [3, 2, 1]);
  assert.deepEqual(t.adc.vs.Caitlyn.Jinx, { g: 3, w: 1 });
  assert.deepEqual([t.sup.games.Thresh, t.bans.Garen, t.bans.Ashe], [3, 3, 3]);
  assert.equal(t.adc.games.Garen, undefined, "top laners are not counted");
  addMatch(t, game(true, { adc: [1, 99] }), idOf); // unknown champion id
  assert.equal(t.adc.games.Jinx, 4);
  assert.equal(t.adc.vs.Jinx.undefined, undefined);
});

test("stats: winrates, percentile scores and counters", () => {
  const t = newTally();
  for (let i = 0; i < 60; i++) addMatch(t, game(i < 40), idOf); // Jinx/Lux win 40 of 60
  for (let i = 0; i < 60; i++) addMatch(t, game(i < 30, { adc: [6, 2], sup: [7, 4], bans: [[], []] }), idOf);
  const s = computeStats(t, { minMatchup: 15 });
  assert.equal(s.matches, 120);
  assert.deepEqual(s.META.adc.Jinx, [67, 66.67]);
  assert.equal(s.META.adc.Caitlyn[1], 41.67); // 25 wins of 60 vs Jinx... + 30 of 60 vs Ashe = 50 / 120
  assert.ok(s.META.adc.Caitlyn[0] === 36, "last of the role gets the bottom of the scale");
  assert.deepEqual(s.COUNTERS.adc.Caitlyn, ["Jinx"], "Jinx wins 2/3 of that lane");
  assert.deepEqual(s.COUNTERS.adc.Jinx, []);
  assert.deepEqual(s.COUNTERS.adc.Ashe, [], "an even matchup is not a counter");
});

test("stats: rarely played champions are left out", () => {
  const t = newTally();
  for (let i = 0; i < 400; i++) addMatch(t, game(i % 2 === 0), idOf);
  addMatch(t, game(true, { adc: [6, 2] }), idOf);
  const s = computeStats(t);
  assert.equal(s.META.adc.Ashe, undefined);
  assert.ok(s.META.adc.Jinx && s.META.adc.Caitlyn);
});

test("rate limiter keeps every window", async () => {
  let t = 0; const calls = [];
  const c = client({ key: "k", limits: parseLimits("2:1,3:10"), log() {}, now: () => t,
    sleep: async ms => { t += ms; }, fetchImpl: async () => { calls.push(t); return { ok: true, json: async () => ({}) }; } });
  for (let i = 0; i < 5; i++) await c.get("https://x/");
  assert.equal(calls.length, 5);
  for (let i = 0; i < calls.length; i++) {
    assert.ok(calls.filter(x => x > calls[i] - 1000 && x <= calls[i]).length <= 2, `1 s window at ${calls[i]}`);
    assert.ok(calls.filter(x => x > calls[i] - 10000 && x <= calls[i]).length <= 3, `10 s window at ${calls[i]}`);
  }
});

test("client waits on 429, skips 404 and stops on a refused key", async () => {
  let t = 0; const answers = [429, 200, 404, 403];
  const c = client({ key: "k", limits: parseLimits("100:1"), log() {}, now: () => t, sleep: async ms => { t += ms; },
    fetchImpl: async () => { const status = answers.shift(); return { ok: status === 200, status, headers: new Map([["retry-after", "3"]]), json: async () => ({ v: 1 }) }; } });
  assert.deepEqual(await c.get("https://x/"), { v: 1 });
  assert.ok(t >= 3000, "waited Retry-After");
  assert.equal(await c.get("https://x/"), null);
  await assert.rejects(c.get("https://x/"), /clé API Riot refusée/);
});

test("fetchStats end to end on a fake API, without leaking the key", async () => {
  const champions = { ids: new Set(Object.values(IDS)) };
  const logs = [], starts = [];
  const fetchImpl = async (url, opts) => {
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (url.includes("versions.json")) return json(["16.19.1"]);
    if (url.includes("champion.json")) return json({ data: Object.fromEntries(Object.entries(IDS).map(([k, id]) => [id, { id, key: k }])) });
    assert.equal(opts.headers["X-Riot-Token"], "SECRET");
    if (url.includes("/league-exp/")) return json([{ puuid: "p-" + url.split("/").slice(-1)[0] }, {}]);
    if (url.includes("/by-puuid/")) starts.push(Number(new URL(url).searchParams.get("startTime")));
    if (url.includes("/by-puuid/")) return json(Array.from({ length: 26 }, (_, i) => `EUW1_${i}`)); // same games for everyone
    const n = Number(url.split("_").pop());
    return json({ info: { ...game(n % 3 !== 0, { version: n === 0 ? "16.18.1.1" : "16.19.823.722" }), gameCreation: 1_790_000_000_000 } });
  };
  const env = { STATS_API_KEY: "SECRET", RIOT_TIERS: "MASTER,DIAMOND", STATS_MIN_MATCHES: "10", RIOT_RATE: "1000:1", STATS_CACHE_DIR: "" };
  const r = await fetchStats({ patch: "26.19", champions, env, fetchImpl, log: m => logs.push(m) });
  assert.equal(r.patch, "26.19");
  assert.match(r.scope, /^EUW Diamant\+, 25 parties$/, "26 distinct games, one from the previous patch");
  assert.ok(r.META.adc.Jinx && r.META.sup.Thresh);
  assert.ok(!logs.join(" ").includes("SECRET"));
  assert.ok(starts.length >= 2 && starts[0] < 1_790_000_000 && starts.at(-1) === 1_790_000_000, "startTime moves past the old-patch game");
  await assert.rejects(fetchStats({ patch: "26.19", champions, env: { ...env, STATS_MIN_MATCHES: "50" }, fetchImpl, log() {} }), /pas assez/);
  await assert.rejects(fetchStats({ patch: "26.19", champions, env: { ...env, STATS_API_KEY: "" }, fetchImpl, log() {} }), /clé API Riot absente/);
});

test("games add up across runs through the local cache, and a new patch starts over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "riot-cache-"));
  const champions = { ids: new Set(Object.values(IDS)) };
  let batch = 0, detailCalls = 0;
  const fetchImpl = async url => {
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (url.includes("versions.json")) return json(["16.19.1"]);
    if (url.includes("champion.json")) return json({ data: Object.fromEntries(Object.entries(IDS).map(([k, id]) => [id, { id, key: k }])) });
    if (url.includes("/league-exp/")) return json([{ puuid: "p" }]);
    if (url.includes("/by-puuid/")) return json(Array.from({ length: 30 }, (_, i) => `EUW1_${batch * 30 + i}`));
    detailCalls++;
    return json({ info: game(true, { version: url.includes("patch20") ? "16.20.1.1" : "16.19.823.722" }) });
  };
  const env = { STATS_API_KEY: "k", RIOT_TIERS: "MASTER", STATS_MIN_MATCHES: "10", RIOT_RATE: "1000:1", STATS_CACHE_DIR: dir };
  const run = patch => fetchStats({ patch, champions, env, fetchImpl, log() {} });
  assert.match((await run("26.19")).scope, /, 30 parties$/);
  assert.equal(detailCalls, 30);
  assert.match((await run("26.19")).scope, /, 30 parties$/, "same games are not read twice");
  assert.equal(detailCalls, 30);
  batch = 1;
  assert.match((await run("26.19")).scope, /, 60 parties$/, "new games add up");
  const files = readdirSync(dir);
  assert.deepEqual(files, ["riot-26.19-euw1-master.json"]);
  const cached = readFileSync(join(dir, files[0]), "utf8");
  assert.ok(!cached.includes('"p"') && !cached.includes("puuid"), "no player id in the cache");
  writeFileSync(join(dir, "riot-26.18-euw1-master.json"), "{}");
  await assert.rejects(run("26.20"), /pas assez/, "26.20 games are not in the 26.19 lists of this fake");
  assert.deepEqual(readdirSync(dir).sort(), ["riot-26.20-euw1-master.json"], "older patches are cleaned up");
});

test("the lane of the player a game was found through is left out", () => {
  const t = newTally();
  const g = game(true);
  g.participants[1].puuid = "seed"; // blue ADC (Jinx) is the seed
  addMatch(t, g, idOf, p => p === "seed");
  assert.equal(t.matches, 1);
  assert.equal(t.adc.games.Jinx, undefined, "the seed's champion is not counted");
  assert.equal(t.adc.games.Caitlyn, undefined, "nor its lane opponent");
  assert.deepEqual([t.sup.games.Lux, t.sup.games.Thresh], [1, 1], "the other lane still counts");
});

test("only champions with a profile get a tier score, others still count as opponents", () => {
  const t = newTally();
  for (let i = 0; i < 60; i++) addMatch(t, game(i < 40), idOf);
  const s = computeStats(t, { ranked: { adc: new Set(["Caitlyn"]), sup: new Set(["Lux", "Thresh"]) } });
  assert.deepEqual(Object.keys(s.META.adc), ["Caitlyn"]);
  assert.equal(s.META.adc.Caitlyn[0], 67, "alone in its role: top of the scale");
  assert.deepEqual(s.COUNTERS.adc.Caitlyn, ["Jinx"], "Jinx has no profile but beats Caitlyn");
  assert.deepEqual(s.COUNTERS.adc.Jinx, [], "an unranked enemy still has its counters list");
});

test("duos, game length and matchups are measured", () => {
  const t = newTally();
  for (let i = 0; i < 60; i++) addMatch(t, { ...game(i < 40), gameDuration: i % 2 ? 1300 : 2000 }, idOf);
  const s = computeStats(t, { minMatchup: 15, minDuo: 20, minPhase: 20 });
  assert.deepEqual(s.DUO_STATS["Jinx|Lux"], [60, 40]);
  assert.deepEqual(s.DUO_STATS["Caitlyn|Thresh"], [60, 20]);
  assert.deepEqual(s.MATCHUPS.adc.Jinx.Caitlyn, [60, 40]);
  assert.deepEqual(s.STATS.adc.Jinx, [60, 100, 0], "in every counted lane, never banned");
  assert.deepEqual(s.MATCHUPS.adc.Caitlyn.Jinx, [60, 20]);
  assert.equal(s.PHASES.adc.Jinx.length, 4);
  assert.equal(s.PHASES.adc.Jinx[0] + s.PHASES.adc.Jinx[2], 60, "every game is short or long here");
  const seeded = newTally(); const g = game(true); g.participants[2].puuid = "seed"; // blue support
  addMatch(seeded, g, idOf, p => p === "seed");
  assert.deepEqual(seeded.duos, { "Caitlyn|Thresh": { g: 1, w: 0 } }, "the duo with the seed is left out");
});

test("a tally cached before duos were counted is upgraded", () => {
  const old = { matches: 3, bans: {}, adc: { games: { Jinx: 3 }, wins: { Jinx: 2 }, vs: {} }, sup: { games: {}, wins: {}, vs: {} } };
  addMatch(old, game(true), idOf);
  assert.equal(old.adc.games.Jinx, 4);
  assert.deepEqual(old.duos["Jinx|Lux"], { g: 1, w: 1 });
});

test("bans count for a role in proportion to the games played in it", () => {
  const t = newTally();
  // Lux: support in 30 games, mid (here: top slot) in 30 more, banned in all 60 by red side
  for (let i = 0; i < 30; i++) addMatch(t, game(true, { bans: [[], [3]] }), idOf);
  for (let i = 0; i < 30; i++) { const g = game(true, { sup: [7, 4], bans: [[], [3]] }); g.participants[0].championId = 3; addMatch(t, g, idOf); }
  const s = computeStats(t, { minMatchup: 15 });
  assert.equal(s.STATS.sup.Lux[2], 50, "half of its 60 bans belong to support, over 60 matches");
  const old = computeStats({ ...t, pos: undefined, duos: {} });
  assert.equal(old.STATS.sup.Lux[2], null, "unknown for a cache without role counts");
});

test("lane results, keystones and summoner spells are counted", () => {
  const t = newTally();
  for (let i = 0; i < 60; i++) {
    const g = { ...game(i < 30), gameDuration: 1800 };
    g.participants.forEach(p => { p.challenges = { laningPhaseGoldExpAdvantage: p.teamId === 100 && i < 45 ? 1 : 0 };
      p.perks = { styles: [{ selections: [{ perk: p.teamId === 100 ? 8008 : 8021 }] }] }; p.summoner1Id = 7; p.summoner2Id = 4; });
    addMatch(t, g, idOf);
  }
  const s = computeStats(t, { minMatchup: 15, minPhase: 20 });
  assert.deepEqual(s.MATCHUPS.adc.Jinx.Caitlyn, [60, 30, 60, 45], "game won 30/60, lane won 45/60");
  assert.deepEqual(s.LANE_WINS.adc.Jinx, [60, 45]);
  assert.deepEqual(s.KITS.adc.Jinx, { runes: [[8008, 60, 30]], spells: [["4|7", 60, 30]] });
  const plain = newTally(); addMatch(plain, game(true), idOf);
  assert.equal(plain.adc.vs.Jinx.Caitlyn.ln, undefined, "no challenges: lane result unknown, not lost");
});
