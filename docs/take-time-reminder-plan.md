## 寿司郎取号提醒 - 实施计划（方案 A + B 结合）

### 架构总览

```
┌─────────────────────────────────────────────────┐
│  浏览器 (index.html)                             │
│  ├── 每15秒: Workers代理 → 寿司郎API (已有)      │
│  ├── 每5分钟: Workers代理 → AI分析 (方案A)       │
│  ├── 每秒: tickCountdown 检查取号提醒            │
│  └── 显示: 基础计算 + AI预测融合                  │
└─────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────┐           ┌──────────────────┐
│ Cloudflare Worker│           │ QoderWork 定时任务│
│ (代理 + AI中转)  │           │ (每10分钟, 方案B) │
│ - /wechat/api/*  │           │ - 拉取排队数据    │
│ - /ai/analyze    │           │ - AI分析趋势      │
│   ↓ DeepSeek API │           │ - 钉钉推送提醒    │
└─────────────────┘           └──────────────────┘
```

### 文件清单

| 文件 | 动作 | 说明 |
|------|------|------|
| `index.html` | 修改 | 基础提醒 UI + 速度采集 + AI 预测接入 |
| `cloudflare-worker.js` | 修改 | 新增 `/ai/analyze` 端点，代理 LLM API 调用 |
| `wrangler.toml` | 修改 | 添加 AI API key 作为 secret 环境变量 |
| `scripts/queue-monitor.js` | 新增 | CLI 监控脚本，供 QoderWork 定时任务调用 |
| `scripts/config.json` | 新增 | 监控配置 |

---

### 1. index.html 改动

#### 1.1 state 新增字段（`// ---- 状态 ----` 区块）

在 `let state = { ... }` 中新增:

```javascript
targetTime: '',          // "19:00"
suggestedTakeTime: null, // Date 对象
aiPrediction: null,      // AI 返回的预测对象
aiLastFetch: 0,          // 上次 AI 预测时间戳
aiFetchInterval: 300000, // 5分钟一次
```

新增独立对象:

```javascript
let queueMetrics = {
  speedShort: -1,        // 最近10条 桌/小时
  speedLong: -1,         // 最近30条 桌/小时
  speedAvg: -1,          // 加权平均
  calcWait: -1,          // 自算等待(分钟)
  lastTakeTimeAlert: 0,  // 上次提醒时间戳
};
```

#### 1.2 UI：stats-grid 新增卡片（在"叫号速度"卡片后面加）

```html
<div class="stat-card" id="reminderCard" style="display:none; border-color:var(--blue);">
  <div class="stat-label">🎯 建议取号时间</div>
  <div class="stat-value" id="suggestTime" style="color:var(--blue); font-size:28px;">--:--</div>
  <div class="stat-sub" id="suggestCountdown">设置目标时间后显示</div>
  <div class="stat-sub" id="aiStatus" style="color:var(--yellow); font-size:11px; margin-top:4px;">
    AI分析: 未启用
  </div>
</div>
```

#### 1.3 UI：control-row 新增时间输入（在提醒阈值 input 前面加）

```html
<span style="font-size:12px;color:var(--text-secondary);margin-left:auto;">
  🎯 目标用餐:
  <input type="time" id="inputTargetTime" style="width:110px;padding:4px 8px;" />
  <button class="btn btn-sm" onclick="setTargetTime()">设定</button>
</span>
```

#### 1.4 新增函数：calcQueueSpeed()

```javascript
function calcQueueSpeed() {
  // 从 history 数组取最近 N 条，计算 currentNumber 变化率
  // 过滤掉 currentNumber 不变的点（说明没叫号）
  //
  // speed = (末条currentNumber - 首条currentNumber) / 时间跨度(小时)
  //
  // speedShort: N=10 (约2.5分钟窗口)
  // speedLong:  N=30 (约7.5分钟窗口)
  // speedAvg = short*0.6 + long*0.4
  //
  // 数据不足(<5条): speedAvg = -1
  //
  // calcWait = tablesAhead / speedAvg * 60
  // 如果 speedAvg=-1, calcWait 用 estimatedWait 兜底

  const m = queueMetrics;
  if (history.length < 2) { m.speedShort = m.speedLong = m.speedAvg = -1; m.calcWait = state.estimatedWait; return; }

  function calcSpeed(n) {
    const slice = history.slice(-n).filter(r => !isNaN(parseInt(r.current_number)));
    if (slice.length < 2) return -1;
    const first = slice[0], last = slice[slice.length - 1];
    const numDiff = parseInt(last.current_number) - parseInt(first.current_number);
    const timeDiff = (new Date(last.time) - new Date(first.time)) / 3600000; // 小时
    if (timeDiff <= 0 || numDiff <= 0) return -1;
    return numDiff / timeDiff;
  }

  m.speedShort = calcSpeed(10);
  m.speedLong = calcSpeed(30);

  if (m.speedShort > 0 && m.speedLong > 0) {
    m.speedAvg = m.speedShort * 0.6 + m.speedLong * 0.4;
  } else if (m.speedShort > 0) {
    m.speedAvg = m.speedShort;
  } else if (m.speedLong > 0) {
    m.speedAvg = m.speedLong;
  } else {
    m.speedAvg = -1;
  }

  if (m.speedAvg > 0 && state.tablesAhead > 0) {
    m.calcWait = state.tablesAhead / m.speedAvg * 60;
  } else {
    m.calcWait = state.estimatedWait;
  }
}
```

#### 1.5 新增函数：fetchAIPrediction()

```javascript
async function fetchAIPrediction() {
  if (!state.targetTime) return;
  if (Date.now() - state.aiLastFetch < state.aiFetchInterval) return;
  if (history.length < 5) return; // 数据不足，等积累

  const payload = {
    storeName: state.storeName,
    currentTime: new Date().toISOString(),
    targetTime: state.targetTime,
    currentNumber: state.currentNumber,
    tablesAhead: state.tablesAhead,
    totalWaiting: state.totalWaiting,
    apiWait: state.estimatedWait,
    history: history.slice(-20).map(h => ({
      time: h.time,
      current_number: h.current_number,
      tables_ahead: h.tables_ahead,
      total_waiting: h.total_waiting,
    })),
  };

  try {
    const cfg = loadCfg();
    const resp = await fetch(cfg.proxyUrl + '?path=/ai/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (resp.ok) {
      state.aiPrediction = await resp.json();
      state.aiLastFetch = Date.now();
      updateAIStatus();
      updateSuggestedTakeTime(); // AI 预测到达后重新计算
    }
  } catch(e) {
    console.warn('AI 预测失败，降级为纯脚本模式:', e.message);
  }
}

function updateAIStatus() {
  const el = document.getElementById('aiStatus');
  if (!el) return;
  if (state.aiPrediction) {
    const p = state.aiPrediction;
    el.textContent = `AI: ${p.trend} | 置信度 ${p.confidence} | ${new Date(state.aiLastFetch).toLocaleTimeString('zh-CN')}`;
    el.style.color = p.confidence > 0.7 ? 'var(--green)' : 'var(--yellow)';
  } else {
    el.textContent = 'AI分析: 等待数据积累 (需观察5分钟)';
    el.style.color = 'var(--text-secondary)';
  }
}
```

#### 1.6 新增函数：updateSuggestedTakeTime()

```javascript
function updateSuggestedTakeTime() {
  if (!state.targetTime) return;

  let blendWait;
  const ai = state.aiPrediction;
  const m = queueMetrics;

  if (ai && ai.confidence > 0.5 && ai.predicted_wait_minutes > 0 && m.speedAvg > 0) {
    // AI + 脚本 + API 三源融合
    blendWait = m.calcWait * 0.3 + state.estimatedWait * 0.2 + ai.predicted_wait_minutes * 0.5;
  } else if (m.speedAvg > 0 && state.estimatedWait >= 0) {
    // 脚本 + API 双源
    blendWait = m.calcWait * 0.6 + state.estimatedWait * 0.4;
  } else if (m.speedAvg > 0) {
    blendWait = m.calcWait;
  } else {
    // 纯 API 兜底
    blendWait = state.estimatedWait >= 0 ? state.estimatedWait : 60;
  }

  const buffer = 10;
  const [h, min] = state.targetTime.split(':').map(Number);
  const target = new Date();
  target.setHours(h, min, 0, 0);

  state.suggestedTakeTime = new Date(target.getTime() - (blendWait + buffer) * 60000);

  document.getElementById('suggestTime').textContent =
    state.suggestedTakeTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('reminderCard').style.display = '';
  updateSuggestCountdown();
}
```

#### 1.7 新增函数：updateSuggestCountdown()

```javascript
function updateSuggestCountdown() {
  if (!state.suggestedTakeTime) return;
  const el = document.getElementById('suggestCountdown');
  const diff = state.suggestedTakeTime - new Date();
  if (diff <= 0) {
    el.textContent = '⏰ 现在就该取号了!';
    el.style.color = 'var(--accent-glow)';
  } else {
    const mins = Math.ceil(diff / 60000);
    el.textContent = `还有 ${mins} 分钟`;
    el.style.color = '';
  }
}
```

#### 1.8 修改 applyStoreData()

在 `updateUI();` 调用前插入:

```javascript
calcQueueSpeed();
updateSuggestedTakeTime();
// 每5分钟触发一次 AI 预测（非阻塞）
if (state.targetTime && Date.now() - state.aiLastFetch > state.aiFetchInterval) {
  fetchAIPrediction();
}
```

#### 1.9 修改 tickCountdown()：取号提醒检查

```javascript
function tickCountdown() {
  countdown--;
  if (countdown < 0) countdown = pollInterval;
  updateCountdown();
  updateSuggestCountdown();

  // 取号提醒检查
  if (state.suggestedTakeTime) {
    const now = Date.now();
    const diff = now - state.suggestedTakeTime.getTime();
    const sinceLastAlert = now - queueMetrics.lastTakeTimeAlert;

    if (diff >= 0 && sinceLastAlert > 300000) {
      toast('⏰ 该取号了!', `建议取号时间已到，目标 ${state.targetTime} 用餐`);
      if (soundEnabled) beep(2);
      document.getElementById('alertBanner').className = 'alert-banner urgent';
      document.getElementById('alertBanner').textContent = '⏰ 现在该取号了! 目标 ' + state.targetTime + ' 用餐';
      queueMetrics.lastTakeTimeAlert = now;
    } else if (diff >= -900000 && diff < 0 && sinceLastAlert > 600000) {
      // 15分钟内到建议取号时间，提前预警
      const minsLeft = Math.ceil(-diff / 60000);
      toast('⚠️ 即将到取号时间', `还有 ${minsLeft} 分钟到建议取号时间`);
      if (soundEnabled) beep(1);
      queueMetrics.lastTakeTimeAlert = now;
    }
  }
}
```

#### 1.10 新增函数：setTargetTime()

```javascript
function setTargetTime() {
  const t = document.getElementById('inputTargetTime').value;
  if (!t) return;
  state.targetTime = t;
  localStorage.setItem('sushiro-target-time-' + activeStoreId, t);
  updateSuggestedTakeTime();
  toast('🎯 目标已设定', t + ' 用餐，系统将计算建议取号时间');
}
```

#### 1.11 修改 init()：恢复 targetTime

在 init 函数中，提醒阈值恢复代码（`document.getElementById('alertLeave').value = al;`）后面加:

```javascript
// 目标用餐时间
const tt = localStorage.getItem('sushiro-target-time-' + activeStoreId);
if (tt) {
  state.targetTime = tt;
  document.getElementById('inputTargetTime').value = tt;
}
```

---

### 2. cloudflare-worker.js 改动

#### 2.1 修改 fetch handler 路由

在现有的路径校验逻辑中，增加 `/ai/analyze` 路由:

```javascript
// 在 ALLOWED_PREFIXES 中增加
const ALLOWED_PREFIXES = ["/wechat/api/", "/ai/"];

// 在 fetch handler 中，path 校验通过后:
if (path === '/ai/analyze') {
  return await handleAIAnalyze(req, env);
}
// 否则走原有的寿司郎 API 代理逻辑
```

#### 2.2 新增 handleAIAnalyze 函数

```javascript
async function handleAIAnalyze(req, env) {
  const apiKey = env.AI_API_KEY;
  if (!apiKey) {
    return jsonRes({ error: 'AI not configured' }, 503, req);
  }

  const payload = await req.json();

  const prompt = `你是寿司郎排队预测助手。分析以下排队数据并预测趋势。

门店: ${payload.storeName}
当前时间: ${payload.currentTime}
目标用餐时间: ${payload.targetTime}
当前叫号: ${payload.currentNumber}
前面桌数: ${payload.tablesAhead}
总排队: ${payload.totalWaiting}
API预计等待: ${payload.apiWait}分钟

最近历史数据(按时间顺序):
${JSON.stringify(payload.history, null, 2)}

请分析叫号速度变化趋势，并严格返回以下JSON格式(不要markdown代码块，直接返回JSON):
{
  "trend": "加速或稳定或减速",
  "predicted_speed_30min": 数字,
  "predicted_wait_minutes": 数字,
  "suggested_take_time": "HH:MM",
  "confidence": 0.0到1.0的数字,
  "reasoning": "一句话中文解释"
}`;

  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 300,
      }),
    });

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return jsonRes({ error: 'AI returned empty' }, 500, req);

    let prediction;
    try {
      prediction = JSON.parse(content);
    } catch(e) {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) prediction = JSON.parse(match[0]);
      else return jsonRes({ error: 'AI response not JSON', raw: content }, 500, req);
    }

    return jsonRes(prediction, 200, req);
  } catch(e) {
    return jsonRes({ error: 'AI analysis failed', detail: e.message }, 500, req);
  }
}
```

#### 2.3 修改 fetch handler 签名

由于需要访问 `env`（Wrangler 环境变量），fetch handler 需要接收 env 参数:

```javascript
// 原来可能是:
// export default { fetch(req) { ... } }
// 改为:
export default {
  async fetch(req, env) {
    // ... 现有逻辑 ...
    // 在路由判断处传入 env:
    if (path === '/ai/analyze') {
      return await handleAIAnalyze(req, env);
    }
    // ...
  }
};
```

---

### 3. wrangler.toml 改动

无需修改文件，但需要手动设置 secret:

```bash
wrangler secret put AI_API_KEY
# 输入 DeepSeek API key
```

---

### 4. scripts/queue-monitor.js（新增）

CLI 监控脚本，供 QoderWork 定时任务调用。

```javascript
/**
 * 寿司郎排队监控 CLI 脚本
 * 用法: node scripts/queue-monitor.js --store 3011 --target 19:00 [--buffer 10]
 * 输出: JSON 格式的排队分析数据
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 解析命令行参数
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf('--' + name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const storeId = getArg('store', '3011');
const targetTime = getArg('target', null);
const buffer = parseInt(getArg('buffer', '10'));

// 读取配置
const configPath = path.join(__dirname, 'config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch(e) {
  console.error('无法读取 scripts/config.json');
  process.exit(1);
}

// 历史记录文件
const historyPath = path.join(__dirname, 'queue-history.json');

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  } catch(e) {
    return [];
  }
}

function saveHistory(h) {
  fs.writeFileSync(historyPath, JSON.stringify(h.slice(-200)));
}

// HTTP GET 封装
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  const store = config.stores.find(s => s.id === storeId) || config.stores[0];
  const auth = config.token.startsWith('Bearer ') ? config.token : 'Bearer ' + config.token;

  const apiUrl = config.proxyUrl
    + '?path=' + encodeURIComponent('/wechat/api/2.0/getStoreById?storeId=' + storeId)
    + '&auth=' + encodeURIComponent(auth)
    + '&code=' + encodeURIComponent(config.appCode);

  const data = await fetchJSON(apiUrl);

  // 解析当前叫号
  const gq = data.groupQueues || {};
  const allNums = [...(gq.boothQueue || []), ...(gq.mixedQueue || []), ...(gq.counterQueue || [])];
  const currentNumber = allNums.length > 0 ? allNums[allNums.length - 1] : '---';

  const sample = {
    time: new Date().toISOString(),
    current_number: currentNumber,
    total_waiting: data.wait || 0,
    api_wait: data.waitTimeCounter >= 0 ? data.waitTimeCounter : -1,
  };

  const history = loadHistory();
  history.push(sample);
  saveHistory(history);

  // 计算速度
  function calcSpeed(n) {
    const slice = history.slice(-n).filter(r => !isNaN(parseInt(r.current_number)));
    if (slice.length < 2) return -1;
    const first = slice[0], last = slice[slice.length - 1];
    const numDiff = parseInt(last.current_number) - parseInt(first.current_number);
    const timeDiff = (new Date(last.time) - new Date(first.time)) / 3600000;
    if (timeDiff <= 0 || numDiff <= 0) return -1;
    return numDiff / timeDiff;
  }

  const speedShort = calcSpeed(10);
  const speedLong = calcSpeed(30);
  let speedAvg = -1;
  if (speedShort > 0 && speedLong > 0) speedAvg = speedShort * 0.6 + speedLong * 0.4;
  else if (speedShort > 0) speedAvg = speedShort;
  else if (speedLong > 0) speedAvg = speedLong;

  const calcWait = speedAvg > 0 ? sample.total_waiting / speedAvg * 60 : sample.api_wait;

  let suggestedTakeTime = null;
  let minutesUntilTake = null;
  let shouldNotify = false;

  if (targetTime) {
    const blendWait = speedAvg > 0 && sample.api_wait >= 0
      ? calcWait * 0.6 + sample.api_wait * 0.4
      : calcWait > 0 ? calcWait : sample.api_wait;

    const [h, m] = targetTime.split(':').map(Number);
    const target = new Date();
    target.setHours(h, m, 0, 0);
    const takeTime = new Date(target.getTime() - (blendWait + buffer) * 60000);
    suggestedTakeTime = takeTime.toTimeString().slice(0, 5);
    minutesUntilTake = Math.round((takeTime - new Date()) / 60000);
    shouldNotify = minutesUntilTake <= 15 && minutesUntilTake >= -30;
  }

  const trend = speedShort > 0 && speedLong > 0
    ? (speedShort > speedLong * 1.2 ? '加速' : speedShort < speedLong * 0.8 ? '减速' : '稳定')
    : '数据不足';

  const output = {
    timestamp: new Date().toISOString(),
    store: store.name,
    storeId: store.id,
    currentNumber,
    totalWaiting: sample.total_waiting,
    apiWait: sample.api_wait,
    speed: { short: Math.round(speedShort * 10) / 10, long: Math.round(speedLong * 10) / 10, avg: Math.round(speedAvg * 10) / 10 },
    calcWait: Math.round(calcWait),
    suggestedTakeTime,
    minutesUntilTake,
    trend,
    shouldNotify,
    targetTime,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(e => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});
```

### 5. scripts/config.json（新增）

```json
{
  "proxyUrl": "https://sushiro-proxy.don01936380.workers.dev",
  "token": "Bearer 4OI44O844Kv44Oz5qSc6Ki855So77yad2VjaGF05YWx6YCa4",
  "appCode": "LX6Jh7A4L2vag3TS+rAM8ifIzQkF3ixJM/K8+e/cfxY=",
  "stores": [
    {"id": "3011", "name": "银泰in77 D馆"},
    {"id": "3049", "name": "杭州东站万象汇"}
  ],
  "buffer": 10,
  "dingtalkWebhook": ""
}
```

---

### 6. 分步执行顺序

| 步骤 | 执行者 | 内容 |
|------|--------|------|
| 1 | Qoder | 改 index.html：state 字段 + UI 卡片 + 时间输入（1.1-1.3） |
| 2 | Qoder | 改 index.html：新增所有函数（1.4-1.7, 1.10） |
| 3 | Qoder | 改 index.html：修改 applyStoreData / tickCountdown / init（1.8-1.9, 1.11） |
| 4 | Qoder | 改 cloudflare-worker.js：新增 /ai/analyze 端点（2.1-2.3） |
| 5 | 人工 | `wrangler secret put AI_API_KEY`（输入 DeepSeek API key） |
| 6 | 人工 | `wrangler deploy` 部署 Workers |
| 7 | 人工 | `wrangler pages deploy .` 部署前端 |
| 8 | 人工 | 浏览器测试：打开页面，设定目标时间，观察速度计算和建议时间 |
| 9 | Qoder | 新建 scripts/queue-monitor.js + scripts/config.json |
| 10 | QoderWork | 配置定时任务，每 10 分钟执行 queue-monitor.js |

步骤 1-3 让 Qoder 一次性改完 index.html，步骤 4 单独改 worker，步骤 5-7 手动部署，步骤 8 验证，步骤 9-10 配方案 B 定时任务。
