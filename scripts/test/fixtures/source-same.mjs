export const info = { name: "METAsrc", scope: "toutes élos" };
export async function fetchStats({ previous: p }) {
  return { patch: p.patch, META: p.META, COUNTERS: p.COUNTERS, STATS: p.STATS, MATCHUPS: p.MATCHUPS, PHASES: p.PHASES, DUO_STATS: p.DUO_STATS };
}
