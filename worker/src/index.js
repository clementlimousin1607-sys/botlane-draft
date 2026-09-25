// Botlane Draft - relais Claude (Cloudflare Worker).
// POST / with the draft (JSON) -> NDJSON stream: {"t":"text"}... then {"done":true} or {"error":"code"}.
// The Anthropic key stays in a Worker secret; each IP (IPv6: each /64) gets a per-minute and
// a per-day quota, and a global daily cap bounds the bill.
import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { HttpError, parsePayload, buildPrompt, metaContext, consumeWindows, ipKey, readConfig, corsHeaders } from "./lib.js";

const MAX_BODY = 8 * 1024;
const DAY = 86400;

export class Quota extends DurableObject {
  async consume(windows) {
    const now = Math.floor(Date.now() / 1000);
    const res = consumeWindows((await this.ctx.storage.get("w")) ?? {}, windows, now);
    if (res.ok) {
      await this.ctx.storage.put("w", res.state);
      await this.ctx.storage.setAlarm(Date.now() + 2 * DAY * 1000); // forget idle IPs after 2 days
    }
    return { ok: res.ok, retryAfter: res.retryAfter, window: res.window };
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

// data.json gives the patch, the strongest picks and the patch notes; cached per isolate.
let metaCache = { at: 0, url: "", value: null };
async function loadMeta(url) {
  if (!url) return null;
  if (metaCache.url === url && Date.now() - metaCache.at < 10 * 60 * 1000) return metaCache.value;
  try {
    const res = await fetch(url, { cf: { cacheTtl: 600 } });
    const value = res.ok ? metaContext(await res.json()) : null;
    metaCache = { at: Date.now(), url, value };
    return value;
  } catch (err) {
    console.warn("data.json unreachable:", err.message);
    return metaCache.value;
  }
}

// Real champion names (the app uses Riot's fr_FR names), to reject anything else in the payload.
const DDRAGON = "https://ddragon.leagueoflegends.com";
let champCache = { at: 0, names: null };
async function loadChampionNames() {
  if (champCache.names && Date.now() - champCache.at < 6 * 3600 * 1000) return champCache.names;
  try {
    const versions = await (await fetch(`${DDRAGON}/api/versions.json`, { cf: { cacheTtl: 3600 } })).json();
    const list = await (await fetch(`${DDRAGON}/cdn/${versions[0]}/data/fr_FR/champion.json`, { cf: { cacheTtl: 86400 } })).json();
    champCache = { at: Date.now(), names: new Set(Object.values(list.data).map(c => c.name)) };
  } catch (err) {
    console.warn("champion list unreachable, pattern check only:", err.message);
  }
  return champCache.names;
}

function errorCode(err) {
  // Most specific first: APIUserAbortError and APIConnectionError both extend APIError.
  if (err instanceof Anthropic.APIUserAbortError) return "cancelled";
  if (err instanceof Anthropic.RateLimitError) return "upstream_busy";
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) return "config";
  if (err instanceof Anthropic.APIConnectionError) return "upstream";
  if (err instanceof Anthropic.APIError) return "upstream";
  return "internal";
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

async function checkQuotas(env, cfg, ip) {
  const perIp = await env.QUOTA.get(env.QUOTA.idFromName("ip:" + ipKey(ip))).consume([
    { name: "min", seconds: 60, limit: cfg.perIpMinute },
    { name: "day", seconds: DAY, limit: cfg.perIpDay },
  ]);
  if (!perIp.ok) throw new HttpError(429, "rate_limited", { retryAfter: perIp.retryAfter });
  const global = await env.QUOTA.get(env.QUOTA.idFromName("global")).consume([{ name: "day", seconds: DAY, limit: cfg.globalDay }]);
  if (!global.ok) throw new HttpError(429, "daily_budget", { retryAfter: global.retryAfter });
}

function streamAnalysis(env, cfg, prompt, cors, ctx) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 60_000 });
  const params = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  };
  if (cfg.effort) params.output_config = { effort: cfg.effort };
  if (cfg.fallbacks) { params.fallbacks = cfg.fallbacks; params.betas = ["server-side-fallback-2026-07-01"]; }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter(), enc = new TextEncoder();
  const stream = client.beta.messages.stream(params);
  let open = true;
  const send = async obj => {
    if (!open) return;
    try { await writer.write(enc.encode(JSON.stringify(obj) + "\n")); }
    catch { open = false; stream.abort(); } // the browser went away: stop paying for tokens
  };
  ctx.waitUntil((async () => {
    try {
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") await send({ t: ev.delta.text });
      }
      const msg = await stream.finalMessage();
      // A refusal after server-side fallbacks means every model declined: tell the page to drop the partial text.
      if (msg.stop_reason === "refusal") await send({ error: "refusal" });
      else await send({ done: true, stop: msg.stop_reason });
    } catch (err) {
      const code = errorCode(err);
      if (code !== "cancelled") console.error("anthropic error", code, err.status ?? "", err.message);
      await send({ error: code });
    } finally {
      if (open) await writer.close().catch(() => {});
    }
  })());
  return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", ...cors } });
}

export default {
  async fetch(request, env, ctx) {
    const cfg = readConfig(env);
    const cors = corsHeaders(request.headers.get("origin"), cfg);
    const url = new URL(request.url);
    if (url.pathname !== "/") return json(404, { error: "not_found" });
    if (request.method === "GET") return json(200, { ok: true, service: "botlane-draft-ai", model: cfg.model });
    if (!cors) return json(403, { error: "origin" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json(405, { error: "method" }, cors);
    try {
      if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, "config");
      const text = await request.text();
      if (text.length > MAX_BODY) throw new HttpError(413, "too_large");
      let body;
      try { body = JSON.parse(text); } catch { throw new HttpError(400, "bad_request", { field: "json" }); }
      const payload = parsePayload(body, await loadChampionNames());
      await checkQuotas(env, cfg, request.headers.get("cf-connecting-ip"));
      const prompt = buildPrompt(payload, await loadMeta(cfg.dataUrl));
      return streamAnalysis(env, cfg, prompt, cors, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        const headers = { ...cors, ...(err.extra.retryAfter ? { "retry-after": String(err.extra.retryAfter) } : {}) };
        return json(err.status, { error: err.code, ...err.extra }, headers);
      }
      console.error("relay error", err);
      return json(500, { error: "internal" }, cors);
    }
  },
};
