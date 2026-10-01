#!/usr/bin/env node
// Weekly refresh of META and COUNTERS in data.json (run by .github/workflows/update-stats.yml).
//
//   node scripts/update-stats.mjs [--source <name>] [--data data.json] [--html index.html] [--dry-run]
//
// The stats source is a module in scripts/sources/<name>.mjs, picked with --source or the
// STATS_SOURCE env var (a GitHub repository variable). Contract, see scripts/sources/_template.mjs:
//   export const info = { name: "Nom affiché", scope: "toutes élos" };
//   export async function fetchStats({ patch, champions, previous, env }) {
//     return { patch?, META: { adc: { Id: [score, winrate] }, sup: {...} },
//              COUNTERS: { adc: { Id: ["Id", ...] }, sup: {...} } };
//   }
// Nothing is written when the source is unset, when its result fails validation, or when
// it covers far fewer champions than the current data (a half-broken scrape).
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { formatData } from "./lib/data-format.mjs";
import { readChampions } from "./lib/champions.mjs";
import { validateData } from "./lib/validate.mjs";
import { currentPatch } from "./lib/patch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MIN_COVERAGE = 0.6; // new META must keep at least 60 % of the champions we had per role

const { values: opt } = parseArgs({ options: {
  source: { type: "string" }, adapter: { type: "string" }, data: { type: "string", default: "data.json" },
  html: { type: "string", default: "index.html" }, "dry-run": { type: "boolean", default: false },
  today: { type: "string" },
} });

const summary = lines => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n"); };
const output = (k, v) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
const fail = msg => { console.log(`::error::${msg}`); summary([`### ❌ Mise à jour refusée`, "", msg]); output("changed", "false"); process.exit(1); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function loadAdapter() {
  if (opt.adapter) return import(pathToFileURL(resolve(opt.adapter)).href); // tests only
  const name = (opt.source ?? process.env.STATS_SOURCE ?? "").trim();
  if (!name) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`Nom de source invalide : "${name}"`);
  const file = resolve(here, "sources", `${name}.mjs`);
  if (!existsSync(file)) fail(`Source "${name}" introuvable (attendu : scripts/sources/${name}.mjs)`);
  return import(pathToFileURL(file).href);
}

function diffLines(prev, next) {
  const out = [];
  for (const r of ["adc", "sup"]) {
    const p = prev.META?.[r] ?? {}, n = next.META[r];
    const added = Object.keys(n).filter(id => !p[id]), removed = Object.keys(p).filter(id => !n[id]);
    const moves = Object.keys(n).filter(id => p[id]).map(id => [id, n[id][0] - p[id][0]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
    const counters = Object.keys(n).filter(id => !same(prev.COUNTERS?.[r]?.[id], next.COUNTERS[r][id])).length;
    out.push(`- **${r.toUpperCase()}** : ${Object.keys(n).length} champions` +
      (added.length ? `, entrées : ${added.join(", ")}` : "") + (removed.length ? `, sorties : ${removed.join(", ")}` : "") +
      (moves.length ? `. Plus gros écarts de score : ${moves.map(([id, d]) => `${id} ${d > 0 ? "+" : ""}${d.toFixed(1)}`).join(", ")}` : "") +
      `. Counters modifiés : ${counters}.`);
  }
  return out;
}

const adapter = await loadAdapter();
if (!adapter) {
  const msg = "Aucune source de stats configurée (variable STATS_SOURCE vide) : data.json reste inchangé.";
  console.log(`::notice::${msg}`);
  summary(["### Stats non mises à jour", "", msg, "", "Voir docs/index.html#maj pour brancher une source."]);
  output("changed", "false");
  process.exit(0);
}

const prev = JSON.parse(readFileSync(opt.data, "utf8"));
const champions = readChampions(opt.html);
let patch;
try { ({ patch } = await currentPatch()); }
catch (e) { if (!opt.adapter) fail(`Patch courant introuvable : ${e.message}`); patch = prev.patch; }

let stats;
try { stats = await adapter.fetchStats({ patch, champions, previous: prev, env: process.env }); }
catch (e) { fail(`La source "${adapter.info?.name ?? "?"}" a échoué : ${e.message}`); }

const next = {
  ...prev,
  patch: stats.patch ?? patch,
  source: adapter.info?.name ?? prev.source,
  scope: stats.scope ?? adapter.info?.scope ?? prev.scope,
  META: stats.META,
  COUNTERS: stats.COUNTERS,
};
for (const r of ["adc", "sup"]) {
  const before = Object.keys(prev.META?.[r] ?? {}).length, after = Object.keys(next.META?.[r] ?? {}).length;
  if (before && after < before * MIN_COVERAGE) fail(`META.${r} ne contient plus que ${after} champions contre ${before} : résultat suspect, rien n'est écrit.`);
}
// Fresh stats from the source replace the hand-estimated rows and any measured extra of the old run
for (const k of ["ESTIMATED", "STATS", "MATCHUPS", "PHASES", "LANE_WINS", "KITS", "NAMES", "DUO_STATS"]) if (stats[k]) next[k] = stats[k]; else delete next[k];
const { errors, warnings } = validateData(next, champions);
warnings.forEach(w => console.log(`::warning::${w}`));
if (errors.length) fail(`data.json produit invalide :\n${errors.map(e => "- " + e).join("\n")}`);

if (["patch", "source", "scope", "META", "COUNTERS", "STATS", "MATCHUPS", "PHASES", "LANE_WINS", "KITS", "NAMES", "DUO_STATS"].every(k => same(prev[k], next[k]))) {
  console.log("Stats identiques à la version publiée : rien à faire.");
  summary(["### Stats déjà à jour", "", `Patch ${next.patch}, source ${next.source}.`]);
  output("changed", "false");
  process.exit(0);
}
next.updated = opt.today ?? new Date().toISOString().slice(0, 10);
const lines = [`### Stats patch ${next.patch} (${next.source})`, "", ...diffLines(prev, next)];
if (next.notesPatch && next.notesPatch !== next.patch) lines.push("", `ℹ️ Les patch notes affichées datent du patch ${next.notesPatch} : à mettre à jour à la main dans data.json (PATCH_NOTES, notesPatch).`);
if (warnings.length) lines.push("", ...warnings.map(w => `- ⚠️ ${w}`));
console.log(lines.join("\n"));
summary(lines);
if (!opt["dry-run"]) writeFileSync(opt.data, formatData(next));
output("changed", opt["dry-run"] ? "false" : "true");
