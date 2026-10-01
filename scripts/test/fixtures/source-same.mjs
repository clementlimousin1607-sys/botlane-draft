export const info = { name: "METAsrc", scope: "toutes élos" };
export async function fetchStats({ previous: p }) {
  return { patch: p.patch, META: p.META, COUNTERS: p.COUNTERS, STATS: p.STATS, MATCHUPS: p.MATCHUPS, PHASES: p.PHASES, LANE_WINS: p.LANE_WINS, KITS: p.KITS, NAMES: p.NAMES, DUO_STATS: p.DUO_STATS };
}
