export const info = { name: "BadId", scope: "test" };
export async function fetchStats({ previous }) {
  const META = structuredClone(previous.META); META.adc["Jynx"] = [60, 50];
  return { META, COUNTERS: previous.COUNTERS };
}
