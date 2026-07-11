/**
 * 寿司郎 API 代理 - Supabase Edge Function
 *
 * 部署: supabase functions deploy proxy
 *
 * 前端发来的请求会被转发到寿司郎 API，绕过浏览器 CORS 限制。
 * Token 等认证信息由前端在请求头中传入，不在服务端硬编码。
 */

const TARGET_BASE = "https://crm-cn-prd.sushiro.com.cn";

Deno.serve(async (req: Request): Promise<Response> => {
  // 只允许 GET/POST
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // 从前端请求头中提取 auth 信息
  const auth = req.headers.get("X-Sushiro-Auth") || "";
  const appCode = req.headers.get("X-Sushiro-App-Code") || "";
  const pathAndQuery = new URL(req.url).searchParams.get("path") || "";

  if (!pathAndQuery) {
    return new Response(
      JSON.stringify({ error: '缺少 path 参数，例如 ?path=/wechat/api/2.0/getStoreById?storeId=3011' }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const targetUrl = `${TARGET_BASE}${pathAndQuery}`;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-App-Client": "miniapp",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_1 like Mac OS X) AppleWebKit/605.1.15",
    };
    if (auth) headers["Authorization"] = auth;
    if (appCode) headers["X-App-Code"] = appCode;

    const resp = await fetch(targetUrl, { method: "GET", headers });

    const body = await resp.text();

    return new Response(body, {
      status: resp.status,
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({ error: "代理请求失败", detail: msg }),
      { status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }
});
