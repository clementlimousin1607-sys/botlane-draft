// Template for a stats source. Copy to scripts/sources/<name>.mjs, implement fetchStats,
// then set the repository variable STATS_SOURCE=<name> (and secrets if the source needs a key).
// Files starting with "_" can't be selected as a source.
//
// Scale expected by the app (index.html, metaPts and tierLabel):
//   score  : METAsrc-style tier score, about 36 (tier C) to 67 (tier S+). A source that exposes
//            another scale must be converted here, or the tiers and the scores shift.
//   winrate: percentage, e.g. 50.8
// ESTIMATED (optional): { adc: [ids], sup: [ids] } for rows the source only estimates; omitted = none.
// COUNTERS[role][id] lists the same-role champions that beat `id` most often, best first (max 3 is typical).

export const info = { name: "Nom de la source", scope: "toutes élos" };

export async function fetchStats({ patch, champions, previous, env }) {
  // patch     : "26.19", from Data Dragon
  // champions : { ids: Set, names: { id: "Nom" }, icons: Set } from index.html; map source names to these ids
  // previous  : the current data.json, e.g. to keep a champion's counters when the source has too few games
  // env       : process.env, for API keys passed as GitHub secrets (never log them)
  throw new Error("fetchStats non implémenté");
}
