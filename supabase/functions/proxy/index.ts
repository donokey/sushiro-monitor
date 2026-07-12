/**
 * 寿司郎 API 代理 - Supabase Edge Function
 * 部署: supabase functions deploy proxy --no-verify-jwt
 */

const TARGET_BASE = "https://crm-cn-prd.sushiro.com.cn";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req: Request): Promise<Response> => {
  // CORS 预检请求直接返回
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const pathAndQuery = url.searchParams.get("path") || "";

  if (!pathAndQuery) {
    return new Response(
      JSON.stringify({ error: "缺少 path 参数" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }

  const auth = req.headers.get("X-Sushiro-Auth") || "";
  const appCode = req.headers.get("X-Sushiro-App-Code") || "";

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-App-Client": "miniapp",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_1 like Mac OS X) AppleWebKit/605.1.15",
    };
    if (auth) headers["Authorization"] = auth;
    if (appCode) headers["X-App-Code"] = appCode;

    const resp = await fetch(`${TARGET_BASE}${pathAndQuery}`, { method: "GET", headers });
    const body = await resp.text();

    return new Response(body, {
      status: resp.status,
      headers: { "Content-Type": "application/json;charset=UTF-8", ...CORS },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({ error: "代理请求失败", detail: msg }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }
});
