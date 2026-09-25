#!/usr/bin/env node
// Usage: node scripts/validate-data.mjs [data.json] [index.html]
// Exit code 1 when data.json has errors. Used by the Pages workflow before publishing.
import { readFileSync, appendFileSync } from "node:fs";
import { readChampions } from "./lib/champions.mjs";
import { validateData } from "./lib/validate.mjs";

const [dataPath = "data.json", htmlPath = "index.html"] = process.argv.slice(2);
let data;
try { data = JSON.parse(readFileSync(dataPath, "utf8")); }
catch (e) { console.error(`::error file=${dataPath}::JSON illisible : ${e.message}`); process.exit(1); }

const { errors, warnings } = validateData(data, readChampions(htmlPath));
for (const w of warnings) console.log(`::warning file=${dataPath}::${w}`);
for (const e of errors) console.log(`::error file=${dataPath}::${e}`);
console.log(`${dataPath} : patch ${data.patch}, ${errors.length} erreur(s), ${warnings.length} avertissement(s)`);
if (process.env.GITHUB_STEP_SUMMARY && (errors.length || warnings.length)) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Vérification de ${dataPath}\n\n` +
    [...errors.map(e => `- ❌ ${e}`), ...warnings.map(w => `- ⚠️ ${w}`)].join("\n") + "\n");
}
process.exit(errors.length ? 1 : 0);
