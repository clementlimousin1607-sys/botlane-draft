export const info = { name: "METAsrc", scope: "toutes élos" };
export async function fetchStats({ previous }) { return { patch: previous.patch, META: previous.META, COUNTERS: previous.COUNTERS }; }
