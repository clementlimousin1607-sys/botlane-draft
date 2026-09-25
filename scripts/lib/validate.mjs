// Structural and cross-reference checks for data.json.
// errors   = the app would break or show wrong data -> the update is refused.
// warnings = worth a look (e.g. a champion with stats but no curated profile).
const ROLES = ["adc", "sup"];
const ADC_STYLES = new Set(["hyper", "bully", "allin", "poke", "util", "ap"]);
const SUP_ARCHETYPES = new Set(["engage", "hook", "enchant", "mage", "warden"]);
const NOTE_KINDS = new Set(["buff", "nerf", "mixte", "changement"]);
const MIN_META_PER_ROLE = 10;

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

export function validateData(data, champions) {
  const errors = [], warnings = [];
  const err = m => errors.push(m), warn = m => warnings.push(m);
  const known = (id, where) => {
    if (!champions.ids.has(id)) { err(`${where} : champion inconnu "${id}" (absent de CHAMPS dans index.html)`); return false; }
    if (!champions.icons.has(id)) warn(`${where} : pas d'icône pour "${id}"`);
    return true;
  };
  if (!isObj(data)) return { errors: ["data.json doit contenir un objet"], warnings };

  if (!/^\d{2}\.\d{1,2}$/.test(data.patch ?? "")) err(`patch invalide : ${JSON.stringify(data.patch)} (attendu "26.19")`);
  if (data.notesPatch !== undefined && !/^\d{2}\.\d{1,2}$/.test(data.notesPatch)) err(`notesPatch invalide : ${JSON.stringify(data.notesPatch)}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.updated ?? "") || Number.isNaN(Date.parse(data.updated))) err(`updated invalide : ${JSON.stringify(data.updated)} (attendu AAAA-MM-JJ)`);
  if (typeof data.source !== "string" || !data.source.trim()) err("source manquante");
  if (data.scope !== undefined && typeof data.scope !== "string") err("scope doit être une chaîne");

  // META: { adc: { id: [score, winrate] }, sup: {...} }
  if (!isObj(data.META)) err("META manquant");
  else for (const r of ROLES) {
    const m = data.META[r];
    if (!isObj(m)) { err(`META.${r} manquant`); continue; }
    const n = Object.keys(m).length;
    if (n < MIN_META_PER_ROLE) err(`META.${r} : seulement ${n} champions (minimum ${MIN_META_PER_ROLE})`);
    for (const [id, v] of Object.entries(m)) {
      if (!known(id, `META.${r}`)) continue;
      if (!Array.isArray(v) || v.length !== 2 || !isNum(v[0], 0, 100) || !isNum(v[1], 30, 70))
        err(`META.${r}.${id} : attendu [score 0-100, winrate 30-70], reçu ${JSON.stringify(v)}`);
    }
  }

  // COUNTERS: { adc: { id: [ids that beat it] }, sup: {...} }
  if (!isObj(data.COUNTERS)) err("COUNTERS manquant");
  else for (const r of ROLES) {
    const c = data.COUNTERS[r];
    if (!isObj(c)) { err(`COUNTERS.${r} manquant`); continue; }
    for (const [id, list] of Object.entries(c)) {
      if (!known(id, `COUNTERS.${r}`)) continue;
      if (!Array.isArray(list) || list.length > 5) { err(`COUNTERS.${r}.${id} : attendu une liste de 0 à 5 champions`); continue; }
      if (new Set(list).size !== list.length) err(`COUNTERS.${r}.${id} : doublon dans ${JSON.stringify(list)}`);
      if (list.includes(id)) err(`COUNTERS.${r}.${id} : un champion ne peut pas se contrer lui-même`);
      list.forEach(x => known(x, `COUNTERS.${r}.${id}`));
    }
  }

  // Curated profiles
  if (!isObj(data.ADC)) err("ADC manquant");
  else for (const [id, p] of Object.entries(data.ADC)) {
    if (!known(id, "ADC")) continue;
    if (!isObj(p) || !isInt(p.r, 1, 3) || !isInt(p.e, 1, 5) || !isInt(p.s, 1, 5) || !isInt(p.m, 1, 5) || !ADC_STYLES.has(p.k))
      err(`ADC.${id} : profil invalide ${JSON.stringify(p)}`);
    for (const f of ["proj", "tank", "ww", "ss"]) if (p && p[f] !== undefined && p[f] !== 1) err(`ADC.${id}.${f} doit valoir 1 ou être absent`);
  }
  if (!isObj(data.SUP)) err("SUP manquant");
  else for (const [id, p] of Object.entries(data.SUP)) {
    if (!known(id, "SUP")) continue;
    if (!isObj(p) || !SUP_ARCHETYPES.has(p.a) || !isInt(p.lane, 1, 5) || !isInt(p.peel, 1, 5) || !isInt(p.eng, 0, 5))
      err(`SUP.${id} : profil invalide ${JSON.stringify(p)}`);
    for (const f of ["proj", "heal"]) if (p && p[f] !== undefined && p[f] !== 1) err(`SUP.${id}.${f} doit valoir 1 ou être absent`);
  }

  if (!Array.isArray(data.DUOS)) err("DUOS manquant");
  else data.DUOS.forEach(d => {
    const parts = typeof d === "string" ? d.split("|") : [];
    if (parts.length !== 2) return err(`DUOS : "${d}" attendu au format "ADC|Support"`);
    const [a, s] = parts;
    if (known(a, "DUOS") && isObj(data.ADC) && !data.ADC[a]) warn(`DUOS : "${a}" n'a pas de profil ADC`);
    if (known(s, "DUOS") && isObj(data.SUP) && !data.SUP[s]) warn(`DUOS : "${s}" n'a pas de profil SUP`);
  });

  if (!isObj(data.TIPS)) err("TIPS manquant");
  else for (const [id, t] of Object.entries(data.TIPS)) {
    if (!known(id, "TIPS")) continue;
    if (typeof t !== "string" || !t.trim() || t.length > 300) err(`TIPS.${id} : texte vide ou trop long (300 caractères max)`);
  }

  if (!Array.isArray(data.PATCH_NOTES)) err("PATCH_NOTES manquant");
  else data.PATCH_NOTES.forEach((n, i) => {
    if (!Array.isArray(n) || n.length !== 3 || !n.every(x => typeof x === "string" && x.trim()))
      return err(`PATCH_NOTES[${i}] : attendu ["Nom", "buff|nerf|mixte|changement", "texte"]`);
    if (!NOTE_KINDS.has(n[1])) warn(`PATCH_NOTES[${i}] : type "${n[1]}" inhabituel (buff, nerf, mixte, changement)`);
  });

  // Coverage between stats and curated profiles: the app only proposes champions that have a profile.
  if (isObj(data.META) && isObj(data.ADC) && isObj(data.SUP)) {
    const prof = { adc: data.ADC, sup: data.SUP };
    for (const r of ROLES) {
      if (!isObj(data.META[r])) continue;
      for (const id of Object.keys(data.META[r])) if (!prof[r][id]) warn(`META.${r}.${id} : pas de profil ${r.toUpperCase()}, le champion ne sera pas proposé`);
      for (const id of Object.keys(prof[r])) if (!data.META[r][id]) warn(`${r.toUpperCase()}.${id} : pas de stats META, affiché "hors méta"`);
    }
  }
  return { errors, warnings };
}
