/**
 * 寿司郎 API 代理 + AI 预测 - Cloudflare Workers 版
 * 冷启动 < 50ms，比 Supabase Edge Function 快 10-100 倍
 *
 * 部署:
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler secret put AI_API_KEY   # 设置 DeepSeek API key
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function jsonRes(data, status, req) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json;charset=UTF-8", ...corsHeaders(req) },
  });
}

// ---- AI 预测端点 ----
async function handleAIAnalyze(req, env) {
  const apiKey = env.AI_API_KEY;
  if (!apiKey) {
    return jsonRes({ error: "AI not configured" }, 503, req);
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return jsonRes({ error: "invalid JSON body" }, 400, req);
  }

  const prompt = `你是寿司郎排队预测助手。分析以下排队数据并预测趋势。

门店: ${payload.storeName || "未知"}
当前时间: ${payload.currentTime || "未知"}
目标用餐时间: ${payload.targetTime || "未设定"}
当前叫号: ${payload.currentNumber || "未知"}
前面桌数: ${payload.tablesAhead ?? "未知"}
总排队: ${payload.totalWaiting ?? "未知"}
API预计等待: ${payload.apiWait ?? "未知"}分钟
实测叫号速度: ${payload.queueSpeed ?? "未知"}桌/小时

最近20条历史数据:
${JSON.stringify(payload.history || [], null, 2)}

请分析并严格返回以下JSON格式(不要markdown代码块):
{
  "trend": "加速/稳定/减速",
  "predicted_speed_30min": 数字(桌/小时),
  "predicted_wait_minutes": 数字(现在取号预计等几分钟),
  "suggested_take_time": "HH:MM格式",
  "confidence": 0.0到1.0的数字,
  "reasoning": "一句话中文解释"
}`;

  try {
    const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 300,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return jsonRes({ error: "AI API error", detail: errText }, resp.status, req);
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return jsonRes({ error: "AI returned empty" }, 502, req);

    let prediction;
    try {
      prediction = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) prediction = JSON.parse(match[0]);
      else return jsonRes({ error: "AI response not valid JSON", raw: content }, 502, req);
    }

    return jsonRes(prediction, 200, req);
  } catch (e) {
    return jsonRes({ error: "AI analysis failed", detail: e.message }, 500, req);
  }
}

// ---- 主处理 ----
export default {
  async fetch(req, env) {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    const url = new URL(req.url);
    const path = url.searchParams.get("path") || "";

    if (!path) return jsonRes({ error: "missing path" }, 400, req);

    // AI 端点：POST /ai/analyze
    if (path === "/ai/analyze" && req.method === "POST") {
      return await handleAIAnalyze(req, env);
    }

    // 以下为寿司郎 API 代理（GET only）
    if (req.method !== "GET") {
      return jsonRes({ error: "method not allowed" }, 405, req);
    }

    const auth = url.searchParams.get("auth") || "";
    const code = url.searchParams.get("code") || "";

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
