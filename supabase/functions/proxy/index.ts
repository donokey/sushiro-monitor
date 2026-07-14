/**
 * 寿司郎 API 代理 v3 - 路径白名单 + CORS 限制 + 缓存
 */
const TARGET = "https://crm-cn-prd.sushiro.com.cn";

// 允许的 API 路径前缀
const ALLOWED_PREFIXES = ["/wechat/api/"];

// CORS 允许的源（你的仪表盘部署地址）
const ALLOWED_ORIGINS = [
  "http://localhost:8888",
  "http://127.0.0.1:8888",
  "https://donokey.github.io",
  "null", // 本地 file:// 打开时的 origin
];

// 内存缓存：减少重复请求延迟
const cache = new Map<string, { data: string; status: number; expires: number }>();
const CACHE_TTL_MS = 5000; // 5 秒缓存

function getOrigin(req: Request): string {
  return req.headers.get("origin") || "";
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = getOrigin(req);
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function jsonRes(data: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...corsHeaders(req),
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path") || "";
  const auth = url.searchParams.get("auth") || "";
  const code = url.searchParams.get("code") || "";

  if (!path) {
    return jsonRes({ error: "missing path" }, 400, req);
  }

  // SSRF 防护：路径白名单校验
  if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
    return jsonRes({ error: "path not allowed" }, 403, req);
  }

  // 构造目标 URL 并校验 hostname
  let targetUrl: URL;
  try {
    targetUrl = new URL(path, TARGET);
  } catch {
    return jsonRes({ error: "invalid path" }, 400, req);
  }
  if (targetUrl.hostname !== new URL(TARGET).hostname) {
    return jsonRes({ error: "path not allowed" }, 403, req);
  }

  // 检查缓存
  const cacheKey = path;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return new Response(cached.data, {
      status: cached.status,
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "X-Cache": "HIT",
        ...corsHeaders(req),
      },
    });
  }

  try {
    const h: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-App-Client": "miniapp",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_1 like Mac OS X) AppleWebKit/605.1.15",
    };
    if (auth) h["Authorization"] = auth;
    if (code) h["X-App-Code"] = code;

    const r = await fetch(targetUrl.toString(), { headers: h });
    const body = await r.text();

    // 写入缓存
    cache.set(cacheKey, { data: body, status: r.status, expires: Date.now() + CACHE_TTL_MS });

    return new Response(body, {
      status: r.status,
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "X-Cache": "MISS",
        ...corsHeaders(req),
      },
    });
  } catch {
    return jsonRes({ error: "proxy error" }, 502, req);
  }
});
