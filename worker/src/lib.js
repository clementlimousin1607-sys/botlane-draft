// Pure helpers of the relay: payload validation, prompt, quotas, CORS.
// No Cloudflare or SDK imports here, so node --test can cover them.

export class HttpError extends Error {
  constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; this.extra = extra; }
}

// ---------- Payload sent by index.html ----------
// Only champion names and scores: the relay writes the prompt itself, so it cannot be used
// as a free general-purpose Claude proxy. `known` is the set of real champion names (Data
// Dragon, fr_FR like the app); when it could not be loaded, only the NAME pattern applies.
const LANES = [["top", "Top"], ["jgl", "Jungle"], ["mid", "Mid"], ["adc", "ADC"], ["sup", "Support"]];
const NAME = /^\p{L}[\p{L}\p{M} .'&-]{0,23}$/u; // "Kai'Sa", "Nunu & Willump", "Dr. Mundo"
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = field => new HttpError(400, "bad_request", { field });

export function parsePayload(body, known = null) {
  const ok = n => typeof n === "string" && NAME.test(n) && (!known || known.has(n));
  const names = (v, max, field) => {
    if (!Array.isArray(v) || v.length > max || !v.every(ok)) throw bad(field);
    return [...new Set(v)];
  };
  const side = (v, field) => {
    if (!isObj(v)) throw bad(field);
    return Object.fromEntries(LANES.map(([k]) => {
      const n = v[k] ?? null;
      if (n !== null && !ok(n)) throw bad(`${field}.${k}`);
      return [k, n];
    }));
  };
  if (!isObj(body)) throw bad("body");
  if (body.role !== "adc" && body.role !== "sup") throw bad("role");
  if (!isObj(body.pools)) throw bad("pools");
  if (!isObj(body.draft)) throw bad("draft");
  if (!Array.isArray(body.scores) || body.scores.length > 8) throw bad("scores");
  const scores = body.scores.map(s => {
    if (!Array.isArray(s) || s.length !== 2 || !ok(s[0]) || !Number.isInteger(s[1]) || s[1] < 0 || s[1] > 100) throw bad("scores");
    return [s[0], s[1]];
  });
  return {
    role: body.role,
    pools: { adc: names(body.pools.adc, 40, "pools.adc"), sup: names(body.pools.sup, 40, "pools.sup") },
    draft: { a: side(body.draft.a, "draft.a"), e: side(body.draft.e, "draft.e"), bans: names(body.draft.bans, 10, "draft.bans") },
    scores,
  };
}

// ---------- Prompt ----------
// data.json ids ("MissFortune") read better with spaces for the model.
const idToName = id => id.replace(/([a-z])([A-Z])/g, "$1 $2");

export function metaContext(data) {
  if (!isObj(data) || !isObj(data.META)) return null;
  const top = r => Object.entries(data.META[r] ?? {}).sort((a, b) => b[1][0] - a[1][0]).slice(0, 5).map(([id]) => idToName(id));
  const notes = (!data.notesPatch || data.notesPatch === data.patch) && Array.isArray(data.PATCH_NOTES)
    ? data.PATCH_NOTES.slice(0, 6).map(([n, k, t]) => `${n} (${k}) : ${t}`) : [];
  return { patch: String(data.patch ?? ""), topAdc: top("adc"), topSup: top("sup"), notes };
}

export function buildPrompt(p, meta) {
  const roleFr = p.role === "adc" ? "ADC" : "support", mateFr = p.role === "adc" ? "support" : "ADC";
  const mate = p.role === "adc" ? "sup" : "adc";
  const list = a => a.length ? a.join(", ") : "non renseigné";
  const team = t => LANES.map(([k, lab]) => p.draft[t][k] ? `${lab} ${p.draft[t][k]}` : null).filter(Boolean).join(", ") || "rien encore";
  const system = [
    `Tu es un coach League of Legends expert de la bot lane${meta?.patch ? `, patch ${meta.patch}` : ""}.`,
    meta ? `Méta actuelle (toutes élos) : ADC les plus forts ${meta.topAdc.join(", ")} ; supports les plus forts ${meta.topSup.join(", ")}.` : "",
    meta?.notes.length ? `Changements du patch pour la bot lane : ${meta.notes.join(" · ")}` : "",
    `Réponds en français, 120 mots maximum, sans titre. Première ligne : "Pick : <champion>" (ajoute "+ <champion>" pour le duo si tu proposes un duo). Puis 3 puces courtes : lane (niveaux clés, trades), teamfight (placement, cible), une astuce d'objet ou de rune adaptée à la compo adverse.`,
    `Tu ne traites que la draft fournie par l'appli Botlane Draft.`,
  ].filter(Boolean).join("\n");
  const mine = p.draft.a[p.role];
  const ask = (p.pools[mate].length && !p.draft.a.adc && !p.draft.a.sup ? "Propose le meilleur duo possible entre nos deux pools, puis " : "") +
    (mine ? `J'ai déjà choisi ${mine} : donne-moi le plan de jeu avec ce champion.` : "Dis-moi quoi prendre (de préférence dans mon pool) et pourquoi.");
  const user = [
    `Je joue ${roleFr}. Mon pool : ${list(p.pools[p.role])}. Pool de mon duo (${mateFr}) : ${list(p.pools[mate])}.`,
    `Mon équipe : ${team("a")}. En face : ${team("e")}. Bans : ${p.draft.bans.length ? p.draft.bans.join(", ") : "aucun"}.`,
    `Scores calculés par l'appli : ${p.scores.map(([n, s]) => `${n} ${s}/100`).join(", ") || "aucun"}.`,
    ask,
  ].join("\n");
  return { system, user };
}

// ---------- Quotas (fixed windows, state kept by the Quota Durable Object) ----------
// windows: [{ name, seconds, limit }]. Day windows start at 00:00 UTC.
export function consumeWindows(state, windows, nowSec) {
  const next = { ...state };
  for (const w of windows) {
    const start = nowSec - (nowSec % w.seconds);
    const cur = state[w.name];
    if (cur && cur.start === start && cur.count >= w.limit) return { ok: false, retryAfter: start + w.seconds - nowSec, window: w.name, state };
  }
  for (const w of windows) {
    const start = nowSec - (nowSec % w.seconds);
    const cur = state[w.name];
    next[w.name] = cur && cur.start === start ? { start, count: cur.count + 1 } : { start, count: 1 };
  }
  return { ok: true, state: next };
}

// IPv6 users often own a whole /64: count them per /64, not per address.
export function ipKey(ip) {
  if (!ip) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip); // IPv4-mapped IPv6
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return full.slice(0, 4).map(x => x.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export function readConfig(env) {
  const int = (v, d) => { const n = Number.parseInt(v ?? "", 10); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    origins: String(env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean),
    dataUrl: env.DATA_URL || "",
    model: env.MODEL || "claude-opus-5",
    effort: env.EFFORT ?? "low",
    fallbacks: env.FALLBACKS ?? "default",
    maxTokens: int(env.MAX_TOKENS, 4096),
    perIpMinute: int(env.PER_IP_PER_MINUTE, 3),
    perIpDay: int(env.PER_IP_PER_DAY, 20),
    globalDay: int(env.GLOBAL_PER_DAY, 100),
  };
}

export function corsHeaders(origin, cfg) {
  if (!origin || !cfg.origins.includes(origin)) return null;
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "Origin" };
}
