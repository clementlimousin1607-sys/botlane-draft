// Returns a truncated result (a scrape that half-failed): must be refused.
export const info = { name: "Broken", scope: "test" };
export async function fetchStats({ previous }) {
  const cut = o => Object.fromEntries(Object.entries(o).slice(0, 5));
  return { META: { adc: cut(previous.META.adc), sup: cut(previous.META.sup) }, COUNTERS: previous.COUNTERS };
}
