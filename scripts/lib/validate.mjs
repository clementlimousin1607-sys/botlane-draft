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

  // ESTIMATED (optional): { adc: [ids], sup: [ids] } = META rows not read on the source
  if (data.ESTIMATED !== undefined) {
    if (!isObj(data.ESTIMATED)) err("ESTIMATED doit être un objet {adc: [...], sup: [...]}");
    else for (const [r, list] of Object.entries(data.ESTIMATED)) {
      if (!ROLES.includes(r)) { err(`ESTIMATED.${r} : rôle inconnu`); continue; }
      if (!Array.isArray(list)) { err(`ESTIMATED.${r} : attendu une liste de champions`); continue; }
      for (const id of list) if (!isObj(data.META?.[r]) || !data.META[r][id]) err(`ESTIMATED.${r}.${id} : absent de META.${r}`);
    }
  }

  // Measured extras (optional, from the Riot source). [games, wins] pairs must be sane counts.
  const counts = (v, n) => Array.isArray(v) && v.length === n && v.every(x => Number.isInteger(x) && x >= 0) && v.every((x, i) => i % 2 === 0 || x <= v[i - 1]);
  if (data.MATCHUPS !== undefined) {
    if (!isObj(data.MATCHUPS)) err("MATCHUPS doit être un objet {adc: {...}, sup: {...}}");
    else for (const [r, m] of Object.entries(data.MATCHUPS)) {
      if (!ROLES.includes(r) || !isObj(m)) { err(`MATCHUPS.${r} : rôle inconnu ou format invalide`); continue; }
      for (const [id, foes] of Object.entries(m)) {
        if (!known(id, `MATCHUPS.${r}`) || !isObj(foes)) continue;
        for (const [foe, v] of Object.entries(foes)) if (known(foe, `MATCHUPS.${r}.${id}`) && !counts(v, 2) && !counts(v, 4)) err(`MATCHUPS.${r}.${id}.${foe} : attendu [parties, victoires] ou [parties, victoires, lanes, lanes gagnées], reçu ${JSON.stringify(v)}`);
      }
    }
  }
  if (data.STATS !== undefined) {
    if (!isObj(data.STATS)) err("STATS doit être un objet {adc: {...}, sup: {...}}");
    else for (const [r, m] of Object.entries(data.STATS)) {
      if (!ROLES.includes(r) || !isObj(m)) { err(`STATS.${r} : rôle inconnu ou format invalide`); continue; }
      for (const [id, v] of Object.entries(m)) if (known(id, `STATS.${r}`) && !(Array.isArray(v) && v.length === 3 && Number.isInteger(v[0]) && v[0] >= 0 && isNum(v[1], 0, 100) && (v[2] === null || isNum(v[2], 0, 100))))
        err(`STATS.${r}.${id} : attendu [parties, pick %, ban % ou null], reçu ${JSON.stringify(v)}`);
    }
  }
  if (data.PHASES !== undefined) {
    if (!isObj(data.PHASES)) err("PHASES doit être un objet {adc: {...}, sup: {...}}");
    else for (const [r, m] of Object.entries(data.PHASES)) {
      if (!ROLES.includes(r) || !isObj(m)) { err(`PHASES.${r} : rôle inconnu ou format invalide`); continue; }
      for (const [id, v] of Object.entries(m)) if (known(id, `PHASES.${r}`) && !counts(v, 4)) err(`PHASES.${r}.${id} : attendu [parties courtes, victoires, parties longues, victoires], reçu ${JSON.stringify(v)}`);
    }
  }
  if (data.LANE_WINS !== undefined) {
    if (!isObj(data.LANE_WINS)) err("LANE_WINS doit être un objet {adc: {...}, sup: {...}}");
    else for (const [r, m] of Object.entries(data.LANE_WINS)) {
      if (!ROLES.includes(r) || !isObj(m)) { err(`LANE_WINS.${r} : rôle inconnu ou format invalide`); continue; }
      for (const [id, v] of Object.entries(m)) if (known(id, `LANE_WINS.${r}`) && !counts(v, 2)) err(`LANE_WINS.${r}.${id} : attendu [lanes, lanes gagnées], reçu ${JSON.stringify(v)}`);
    }
  }
  if (data.KITS !== undefined) {
    if (!isObj(data.KITS)) err("KITS doit être un objet {adc: {...}, sup: {...}}");
    else for (const [r, m] of Object.entries(data.KITS)) {
      if (!ROLES.includes(r) || !isObj(m)) { err(`KITS.${r} : rôle inconnu ou format invalide`); continue; }
      for (const [id, k] of Object.entries(m)) {
        if (!known(id, `KITS.${r}`)) continue;
        const ok = isObj(k) && Array.isArray(k.runes) && Array.isArray(k.spells)
          && k.runes.every(x => Array.isArray(x) && x.length === 3 && Number.isInteger(x[0]) && counts(x.slice(1), 2))
          && k.spells.every(x => Array.isArray(x) && x.length === 3 && /^\d+\|\d+$/.test(x[0]) && counts(x.slice(1), 2));
        if (!ok) err(`KITS.${r}.${id} : attendu {runes: [[id, parties, victoires]], spells: [["4|7", parties, victoires]]}`);
      }
    }
  }
  if (data.NAMES !== undefined && !(isObj(data.NAMES) && isObj(data.NAMES.perk) && isObj(data.NAMES.spell))) err("NAMES doit être {perk: {id: nom}, spell: {id: nom}}");
  if (data.DUO_STATS !== undefined) {
    if (!isObj(data.DUO_STATS)) err("DUO_STATS doit être un objet {\"Adc|Sup\": [parties, victoires]}");
    else for (const [k, v] of Object.entries(data.DUO_STATS)) {
      const [a, sp] = k.split("|");
      if (!a || !sp) { err(`DUO_STATS : "${k}" attendu au format "ADC|Support"`); continue; }
      if (known(a, "DUO_STATS") && known(sp, "DUO_STATS") && !counts(v, 2)) err(`DUO_STATS.${k} : attendu [parties, victoires], reçu ${JSON.stringify(v)}`);
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
