// Reads the champion list and icon keys embedded in index.html.
// They stay in the HTML (icons are base64), so data.json is checked against them.
import { readFileSync } from "node:fs";

export function readChampions(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const champs = html.match(/^const CHAMPS=(\[.*\]);$/m);
  const icons = html.match(/^const ICONS=(\{.*\});$/m);
  if (!champs || !icons) throw new Error(`CHAMPS / ICONS introuvables dans ${htmlPath}`);
  const list = JSON.parse(champs[1]);
  return {
    ids: new Set(list.map(c => c.id)),
    names: Object.fromEntries(list.map(c => [c.id, c.name])),
    icons: new Set(Object.keys(JSON.parse(icons[1]))),
  };
}
