// Test source: shifts every score by +1 and swaps the first two counters of Caitlyn.
import { readFileSync } from "node:fs";
export const info = { name: "Fixture", scope: "test" };
export async function fetchStats({ previous }) {
  const META = structuredClone(previous.META), COUNTERS = structuredClone(previous.COUNTERS);
  for (const r of ["adc", "sup"]) for (const id in META[r]) META[r][id][0] = Math.round((META[r][id][0] + 1) * 100) / 100;
  COUNTERS.adc.Caitlyn = ["Jhin", "Jinx", "Twitch"];
  return { patch: "26.20", META, COUNTERS };
}
