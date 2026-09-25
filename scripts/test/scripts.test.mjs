import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { formatData } from "../lib/data-format.mjs";
import { validateData } from "../lib/validate.mjs";
import { readChampions } from "../lib/champions.mjs";
import { ddragonToPatch, currentPatch } from "../lib/patch.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataPath = join(root, "data.json"), htmlPath = join(root, "index.html");
const data = JSON.parse(readFileSync(dataPath, "utf8"));
const champions = readChampions(htmlPath);

test("data.json is stored in canonical format", () => {
  assert.equal(readFileSync(dataPath, "utf8"), formatData(data));
  assert.deepEqual(JSON.parse(formatData(data)), data);
});

test("current data.json is valid", () => {
  const { errors } = validateData(data, champions);
  assert.deepEqual(errors, []);
});

test("validator catches unknown ids, bad ranges and self-counters", () => {
  const bad = structuredClone(data);
  bad.META.adc.Jynx = [60, 50];
  bad.META.sup.Lux = [66.8, 95];
  bad.COUNTERS.adc.Jinx = ["Jinx"];
  bad.ADC.Jinx.k = "tank";
  bad.patch = "26";
  const { errors } = validateData(bad, champions);
  for (const needle of ['champion inconnu "Jynx"', "META.sup.Lux", "se contrer lui-même", "ADC.Jinx", "patch invalide"])
    assert.ok(errors.some(e => e.includes(needle)), `missing error about ${needle}: ${errors.join(" | ")}`);
});

test("Data Dragon version maps to the patch name", async () => {
  assert.equal(ddragonToPatch("16.19.1"), "26.19");
  assert.equal(ddragonToPatch("15.1.1"), "25.1");
  assert.throws(() => ddragonToPatch("14.24.1"));
  const fake = async () => ({ ok: true, json: async () => ["16.20.1", "16.19.1"] });
  assert.deepEqual(await currentPatch(fake), { patch: "26.20", ddragon: "16.20.1" });
});

function runUpdate(fixture, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), "bld-"));
  const copy = join(dir, "data.json"), out = join(dir, "out"), sum = join(dir, "sum");
  copyFileSync(dataPath, copy);
  writeFileSync(out, ""); writeFileSync(sum, "");
  const args = [join(root, "scripts/update-stats.mjs"), "--data", copy, "--html", htmlPath, "--today", "2026-10-01"];
  if (fixture) args.push("--adapter", join(root, "scripts/test/fixtures", fixture));
  const env = { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, STATS_SOURCE: "" };
  const r = spawnSync(process.execPath, [...args, ...extra], { env, encoding: "utf8" });
  return { ...r, data: JSON.parse(readFileSync(copy, "utf8")), raw: readFileSync(copy, "utf8"), out: readFileSync(out, "utf8"), sum: readFileSync(sum, "utf8") };
}

test("update without a source is a no-op", () => {
  const r = runUpdate(null);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.out, /changed=false/);
  assert.equal(r.raw, readFileSync(dataPath, "utf8"));
});

test("update with new stats rewrites META/COUNTERS and keeps curated data", () => {
  const r = runUpdate("source-ok.mjs");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.out, /changed=true/);
  assert.equal(r.data.patch, "26.20");
  assert.equal(r.data.updated, "2026-10-01");
  assert.equal(r.data.source, "Fixture");
  assert.equal(r.data.notesPatch, "26.19", "patch notes stay hand-curated");
  assert.equal(r.data.META.adc.Caitlyn[0], 67.88);
  assert.deepEqual(r.data.COUNTERS.adc.Caitlyn, ["Jhin", "Jinx", "Twitch"]);
  assert.deepEqual(r.data.TIPS, data.TIPS);
  assert.equal(r.raw, formatData(r.data));
  assert.match(r.sum, /patch notes affichées datent du patch 26\.19/);
});

test("identical stats do not touch the file", () => {
  const r = runUpdate("source-same.mjs");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.out, /changed=false/);
  assert.equal(r.data.updated, data.updated);
});

test("a truncated scrape is refused", () => {
  const r = runUpdate("source-broken.mjs");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /résultat suspect/);
  assert.equal(r.raw, readFileSync(dataPath, "utf8"));
});

test("an unknown champion id is refused", () => {
  const r = runUpdate("source-badid.mjs");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Jynx/);
});

test("dry run reports but does not write", () => {
  const r = runUpdate("source-ok.mjs", ["--dry-run"]);
  assert.equal(r.status, 0);
  assert.match(r.out, /changed=false/);
  assert.equal(r.raw, readFileSync(dataPath, "utf8"));
});
