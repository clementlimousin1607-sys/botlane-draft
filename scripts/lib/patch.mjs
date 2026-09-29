// Current League patch, from Riot's official Data Dragon version list.
// Since 2025 patches are named after the year: Data Dragon 15.x = patch 25.x, 16.x = 26.x.
export function ddragonToPatch(version) {
  const m = /^(\d+)\.(\d+)\./.exec(version ?? "");
  if (!m || Number(m[1]) < 15) throw new Error(`version Data Dragon inattendue : ${version}`);
  return `${Number(m[1]) + 10}.${Number(m[2])}`;
}

export async function currentPatch(fetchImpl = fetch) {
  const res = await fetchImpl("https://ddragon.leagueoflegends.com/api/versions.json");
  if (!res.ok) throw new Error(`Data Dragon : HTTP ${res.status}`);
  const versions = await res.json();
  return { patch: ddragonToPatch(versions[0]), ddragon: versions[0] };
}

// Inverse mapping, for match-v5 gameVersion ("16.19.823.722" = patch 26.19).
export function patchToGameVersion(patch) {
  const m = /^(\d+)\.(\d+)$/.exec(patch ?? "");
  if (!m || Number(m[1]) < 25) throw new Error(`patch inattendu : ${patch}`);
  return `${Number(m[1]) - 10}.${Number(m[2])}.`;
}
