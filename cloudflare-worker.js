/**
 * 寿司郎 API 代理 - Cloudflare Workers 版
 * 冷启动 < 50ms，比 Supabase Edge Function 快 10-100 倍
 *
 * 部署:
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler deploy
 */

const TARGET = "https://crm-cn-prd.sushiro.com.cn";
const ALLOWED_PREFIXES = ["/wechat/api/"];
const ALLOWED_ORIGINS = [
  "http://localhost:8888",
  "http://127.0.0.1:8888",
  "https://donokey.github.io",
  "https://sushiro-monitor.pages.dev",
  "null",
];

// 内存缓存
const cache = new Map();
const CACHE_TTL_MS = 5000;

function corsHeaders(req) {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function jsonRes(data, status, req) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json;charset=UTF-8", ...corsHeaders(req) },
  });
}

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    const url = new URL(req.url);
    const path = url.searchParams.get("path") || "";
    const auth = url.searchParams.get("auth") || "";
    const code = url.searchParams.get("code") || "";

    if (!path) return jsonRes({ error: "missing path" }, 400, req);

    // SSRF 防护
    if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
      return jsonRes({ error: "path not allowed" }, 403, req);
    }

    let targetUrl;
    try {
      targetUrl = new URL(path, TARGET);
    } catch {
      return jsonRes({ error: "invalid path" }, 400, req);
    }
    if (targetUrl.hostname !== new URL(TARGET).hostname) {
      return jsonRes({ error: "path not allowed" }, 403, req);
    }

    // 缓存检查
    const cached = cache.get(path);
    if (cached && cached.expires > Date.now()) {
      return new Response(cached.data, {
        status: cached.status,
        headers: { "Content-Type": "application/json;charset=UTF-8", "X-Cache": "HIT", ...corsHeaders(req) },
      });
    }

    try {
      const h = {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-App-Client": "miniapp",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_1 like Mac OS X) AppleWebKit/605.1.15",
      };
      if (auth) h["Authorization"] = auth;
      if (code) h["X-App-Code"] = code;

      const r = await fetch(targetUrl.toString(), { headers: h });
      const body = await r.text();

      cache.set(path, { data: body, status: r.status, expires: Date.now() + CACHE_TTL_MS });

      return new Response(body, {
        status: r.status,
        headers: { "Content-Type": "application/json;charset=UTF-8", "X-Cache": "MISS", ...corsHeaders(req) },
      });
    } catch {
      return jsonRes({ error: "proxy error" }, 502, req);
    }
  },
};
