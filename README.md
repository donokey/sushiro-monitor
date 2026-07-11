# 🍣 寿司郎排队监控系统

实时监测寿司郎微信小程序排队叫号, 显示在电脑仪表盘上, 不用盯着手机看。

## ✨ 功能

| 功能 | 说明 |
|------|------|
| 📡 实时状态 | 当前叫号、你的号码、前面桌数、预计等待 |
| 📊 趋势图表 | 历史排队数据折线图 |
| 🔔 智能提醒 | 根据剩余桌数 + 路程时间, 提醒何时出发 |
| 🔊 声音通知 | 到阈值时发出提示音 |
| 🎨 双主题 | 暗色/亮色模式 |
| 📱 响应式 | 支持各种屏幕尺寸 |

## 🚀 快速开始

### 1. 安装 Python

需要 Python 3.8+, 从 https://www.python.org/downloads/ 下载安装。

### 2. 抓包获取 API (关键步骤!)

这是最重要的一步 —— 你需要从寿司郎微信小程序中获取排队 API 的信息。

#### 方案A: PC 微信 + Proxifier (推荐, 最简单)

**工具准备:**

1. 安装 **mitmproxy**: `pip install mitmproxy`
2. 安装 **Proxifier** (下载试用版即可)

**步骤:**

```
1. 打开终端, 启动 mitmproxy:
   mitmweb -s capture_proxy.py

   mitmweb 会打开一个 Web 界面在 http://localhost:8081
   代理监听在 127.0.0.1:8080

2. 在 Proxifier 中设置:
   - Profile → Proxy Servers → Add:
     Address: 127.0.0.1  Port: 8080  Protocol: HTTPS
   - Profile → Proxification Rules → Add:
     Applications: WeChatApp.exe; WeChatAppEx.exe; WechatBrowser.exe
     Action: Proxy HTTPS 127.0.0.1

3. 登录 PC 微信, 打开寿司郎小程序

4. 在小程序中查看排队页面

5. 查看终端输出, 找到排队相关的 API 请求
   或者在 captured_apis/ 目录下查看保存的请求详情
```

#### 方案B: Android + Frida (不需 PC 微信)

参考教程: https://www.52pojie.cn/thread-1948056-1-5.html

#### 方案C: 微信开发者工具 (如果有小程序 AppID)

1. 从 PC 微信缓存中提取小程序包 (路径: `WeChat Files/Applet/`)
2. 用 UnpackMiniApp 解密 .wxapkg
3. 用 unveilr 反编译
4. 导入微信开发者工具, 在 Network 面板查看

### 3. 识别排队 API

在抓包结果中, 找到类似这样的请求:

```
GET https://xxx.com/api/queue/status?storeId=1234
Authorization: Bearer eyJhbG...
```

响应体大概像这样:

```json
{
  "code": 0,
  "data": {
    "storeName": "XX广场店",
    "currentNumber": "A088",
    "tablesAhead": 25,
    "estimatedWaitMinutes": 45,
    "totalWaitingTables": 80
  }
}
```

### 4. 配置 config.json

将抓包获取的信息填入 `config.json`:

```json
{
  "api": {
    "base_url": "https://xxx.com",
    "queue_status_path": "/api/queue/status",
    "store_id": "你的门店ID",
    "poll_interval_seconds": 15,
    "method": "GET",
    "response_mapping": {
      "current_number": "data.currentNumber",
      "store_name": "data.storeName",
      "tables_ahead": "data.tablesAhead",
      "estimated_wait": "data.estimatedWaitMinutes",
      "total_waiting": "data.totalWaitingTables"
    }
  },
  "auth": {
    "token": "你的 Bearer Token",
    "headers": {}
  }
}
```

**response_mapping** 是最关键的配置 —— 它告诉程序如何从 API 响应中提取字段。
使用 `.` 分隔嵌套路径, 例如 `data.currentNumber` 表示 `response["data"]["currentNumber"]`。

### 5. 启动监控

双击 `start.bat` 或命令行运行:

```bash
pip install -r requirements.txt
python monitor.py
```

浏览器打开 **http://localhost:8888**

### 6. 设置你的号码

在仪表盘输入框输入你的取号号码, 点击"设置我的号码"。

## 📁 项目文件

```
sushiro-monitor/
├── monitor.py          # 主程序 (后端 + Web 服务)
├── dashboard.html      # 仪表盘前端页面
├── capture_proxy.py    # mitmproxy 抓包脚本
├── config.json         # 配置文件 (填入 API 信息)
├── requirements.txt    # Python 依赖
├── start.bat           # Windows 一键启动
├── captured_apis/      # 抓包结果保存目录
└── history.json        # 排队历史数据
```

## ⚙️ 配置说明

### response_mapping 详解

不同门店/地区的 API 返回格式可能不同。使用 `response_mapping` 配置路径映射:

| 字段 | 说明 | 示例路径 |
|------|------|----------|
| current_number | 当前叫到的号码 | `data.currentNum` |
| store_name | 门店名称 | `data.shopName` |
| tables_ahead | 前面还有几桌 | `data.waitBefore` |
| estimated_wait | 预计等待(分钟) | `data.waitTime` |
| total_waiting | 总排队数 | `data.total` |

### 提醒配置

| 参数 | 默认 | 说明 |
|------|------|------|
| tables_ahead_warning | 10 | 剩 N 桌时黄色提醒 |
| tables_ahead_leave_now | 5 | 剩 N 桌时红色紧急提醒 |
| travel_time_minutes | 15 | 你到店需要的路程时间 |

## ⚠️ 注意事项

1. **Token 有效期**: 微信小程序的登录 token 可能会过期, 需要定期从抓包中更新
2. **请求频率**: 建议 15-30 秒轮询一次, 太频繁可能被限流
3. **仅供个人使用**: 不要用于商业用途或大规模部署
4. **合法合规**: 仅用于查看自己的排队状态, 不要攻击或滥用 API
