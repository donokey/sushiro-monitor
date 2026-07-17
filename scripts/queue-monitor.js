/**
 * 寿司郎排队监控 CLI 脚本（方案 B）
 * 供 QoderWork 定时任务调用，每 10 分钟执行一次
 *
 * 用法: node scripts/queue-monitor.js
 * 配置: scripts/config.json
 */

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");
const DATA_PATH = path.join(__dirname, "queue-data.json");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
  } catch {
    return { history: [], lastAiAnalysis: null };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

// ---- 拉取排队数据 ----
async function fetchQueueData(cfg) {
  const storeId = cfg.stores[0].id;
  const auth = cfg.token.startsWith("Bearer ") ? cfg.token : "Bearer " + cfg.token;
  const apiPath = `/wechat/api/2.0/getStoreById?storeId=${storeId}`;
  const url = `${cfg.proxyUrl}?path=${encodeURIComponent(apiPath)}&auth=${encodeURIComponent(auth)}&code=${encodeURIComponent(cfg.appCode)}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

// ---- 计算叫号速度 ----
function calcSpeed(history) {
  const valid = history.filter((h) => h.current_number && !isNaN(parseInt(h.current_number)));
  if (valid.length < 5) return { speed: -1, calcWait: -1 };

  const first = valid[0],
    last = valid[valid.length - 1];
  const numDiff = parseInt(last.current_number) - parseInt(first.current_number);
  const hours = (new Date(last.time) - new Date(first.time)) / 3600000;
  if (hours <= 0 || numDiff <= 0) return { speed: -1, calcWait: -1 };

  const speed = Math.round(numDiff / hours);
  return { speed, calcWait: -1 }; // calcWait needs tablesAhead
}

// ---- AI 分析 ----
async function analyzeWithAI(cfg, current, history) {
  const aiKey = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!aiKey) {
    console.log("[AI] 未配置 AI_API_KEY 环境变量，跳过 AI 分析");
    return null;
  }

  const prompt = `你是寿司郎排队预测助手。分析以下数据。

门店: ${cfg.stores[0].name}
当前时间: ${new Date().toISOString()}
目标用餐: ${cfg.target_time}
当前叫号: ${current.currentNumber}
前面桌数: ${current.tablesAhead}
总排队: ${current.totalWaiting}
API预计: ${current.estimatedWait}分钟

最近历史:
${JSON.stringify(history.slice(-20), null, 2)}

严格返回JSON(不要markdown):
{"trend":"加速/稳定/减速","predicted_wait_minutes":数字,"suggested_take_time":"HH:MM","confidence":0-1,"reasoning":"一句话中文"}`;

  const resp = await fetch(cfg.ai_api_url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${aiKey}` },
    body: JSON.stringify({
      model: cfg.ai_model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 300,
    }),
  });

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;

  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  }
}

// ---- 计算建议取号时间 ----
function calcSuggestedTakeTime(cfg, current, speedInfo, aiResult) {
  let blendWait;
  if (aiResult && aiResult.confidence > 0.5 && speedInfo.speed > 0) {
    blendWait = speedInfo.calcWait * 0.3 + current.estimatedWait * 0.2 + aiResult.predicted_wait_minutes * 0.5;
  } else if (speedInfo.speed > 0) {
    blendWait = speedInfo.calcWait * 0.6 + current.estimatedWait * 0.4;
  } else {
    blendWait = current.estimatedWait >= 0 ? current.estimatedWait : 30;
  }

  const buffer = 10;
  const [h, min] = cfg.target_time.split(":").map(Number);
  const target = new Date();
  target.setHours(h, min, 0, 0);
  if (target <= new Date()) target.setDate(target.getDate() + 1);

  return new Date(target.getTime() - (blendWait + buffer) * 60000);
}

// ---- 钉钉推送 ----
async function sendDingTalk(webhook, title, text) {
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { title, text },
      }),
    });
  } catch (e) {
    console.error("[钉钉] 推送失败:", e.message);
  }
}

// ---- 主流程 ----
async function main() {
  const cfg = loadConfig();
  const data = loadData();

  console.log(`[${new Date().toLocaleString("zh-CN")}] 拉取排队数据...`);

  // 1. 拉取数据
  const apiData = await fetchQueueData(cfg);
  const gq = apiData.groupQueues || {};
  const allNums = [...(gq.boothQueue || []), ...(gq.mixedQueue || []), ...(gq.counterQueue || [])];
  const currentNumber = allNums.length > 0 ? allNums[allNums.length - 1] : "---";

  const current = {
    currentNumber,
    totalWaiting: apiData.wait || 0,
    estimatedWait: apiData.waitTimeCounter >= 0 ? apiData.waitTimeCounter : -1,
    tablesAhead: -1,
  };

  console.log(`  当前叫号: ${currentNumber} | 总排队: ${current.totalWaiting}桌 | API预计: ${current.estimatedWait}分钟`);

  // 2. 记录历史
  const entry = {
    time: new Date().toISOString(),
    current_number: currentNumber,
    total_waiting: current.totalWaiting,
    estimated_wait: current.estimatedWait,
  };
  data.history.push(entry);
  if (data.history.length > 500) data.history = data.history.slice(-500);

  // 3. 计算速度
  const speedInfo = calcSpeed(data.history);
  if (speedInfo.speed > 0 && current.tablesAhead >= 0) {
    speedInfo.calcWait = Math.round((current.tablesAhead / speedInfo.speed) * 60);
  }
  console.log(`  叫号速度: ${speedInfo.speed}桌/小时`);

  // 4. AI 分析（每 30 分钟一次）
  let aiResult = data.lastAiAnalysis;
  const shouldAnalyze = !aiResult || Date.now() - new Date(aiResult.timestamp).getTime() > 30 * 60000;
  if (shouldAnalyze && data.history.length >= 5) {
    console.log("  AI 分析中...");
    aiResult = await analyzeWithAI(cfg, current, data.history);
    if (aiResult) {
      aiResult.timestamp = new Date().toISOString();
      data.lastAiAnalysis = aiResult;
      console.log(`  AI: ${aiResult.trend} | 预计等待 ${aiResult.predicted_wait_minutes}分钟 | 置信度 ${aiResult.confidence}`);
    }
  }

  // 5. 计算建议取号时间
  const suggestedTime = calcSuggestedTakeTime(cfg, current, speedInfo, aiResult);
  const now = new Date();
  const diff = suggestedTime - now;
  const minsLeft = Math.ceil(diff / 60000);

  console.log(`  建议取号: ${suggestedTime.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} (还有 ${minsLeft > 0 ? minsLeft : 0} 分钟)`);

  // 6. 推送提醒
  if (diff <= 0 && diff > -5 * 60000) {
    // 刚到建议取号时间（5分钟窗口内）
    const msg = `🍣 **寿司郎排队提醒**\n\n` +
      `- 当前叫号: ${currentNumber}\n` +
      `- 总排队: ${current.totalWaiting}桌\n` +
      `- 叫号速度: ${speedInfo.speed}桌/小时\n` +
      `- 目标: ${cfg.target_time} 用餐\n\n` +
      `**⏰ 现在该取号了!**`;
    await sendDingTalk(cfg.dingtalk_webhook, "该取号了!", msg);
    console.log("  📨 已推送取号提醒");
  }

  // 7. 保存数据
  saveData(data);
  console.log("  ✅ 完成");
}

main().catch((e) => {
  console.error("❌ 执行失败:", e.message);
  process.exit(1);
});
