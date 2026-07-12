/**
 * 寿司郎 API 代理 v2 - 参数全部走 query string，零 CORS 预检
 */
const TARGET = "https://crm-cn-prd.sushiro.com.cn";

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.searchParams.get("path") || "";
  const auth = url.searchParams.get("auth") || "";
  const code = url.searchParams.get("code") || "";

  if (!path) {
    return Response.json({ error: "missing path" }, {
      status: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
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

    const r = await fetch(TARGET + path, { headers: h });
    const body = await r.text();

    return new Response(body, {
      status: r.status,
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e: unknown) {
    return Response.json({ error: "proxy error", detail: String(e) }, {
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
});
