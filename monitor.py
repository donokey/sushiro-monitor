"""
寿司郎排队监控 - 主程序

功能:
    1. 定时轮询寿司郎排队 API
    2. 记录排队历史数据
    3. 提供 Web 仪表盘 (http://localhost:8888)
    4. 桌面通知 + 声音提醒

启动:
    python monitor.py

依赖:
    pip install flask flask-cors requests
"""

import json
import os
import sys
import time
import secrets
import threading
import queue
import logging
from datetime import datetime, timedelta
from pathlib import Path

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

# ============================================================
# 配置
# ============================================================
SCRIPT_DIR = Path(__file__).parent.absolute()
CONFIG_FILE = SCRIPT_DIR / "config.json"
HISTORY_FILE = SCRIPT_DIR / "history.json"
STATIC_DIR = SCRIPT_DIR

PORT = 8888
# 启动时生成随机 API Key，用于保护配置写入接口
API_KEY = secrets.token_urlsafe(16)

# 日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("sushiro")


# ============================================================
# 配置管理
# ============================================================
def load_config():
    if not CONFIG_FILE.exists():
        log.error(f"配置文件 {CONFIG_FILE} 不存在!")
        log.error("请先复制 config.json 并填入你的 API 信息")
        sys.exit(1)
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_history(data):
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_history():
    if HISTORY_FILE.exists():
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"records": [], "max_records": 500}


# ============================================================
# API 轮询引擎
# ============================================================
class QueueMonitor:
    """排队状态监控器"""

    def __init__(self, config):
        self.config = config
        self.api_config = config["api"]
        self.auth_config = config["auth"]
        self.user_config = config["user"]
        self.alert_config = config["alerts"]

        # 当前状态
        self.current_status = {
            "connected": False,
            "last_update": None,
            "last_error": None,
            "error_count": 0,
            "store_name": "加载中...",
            "current_number": "---",
            "my_number": self.user_config.get("my_queue_number", ""),
            "tables_ahead": -1,
            "estimated_wait_minutes": -1,
            "queue_speed_per_hour": -1,
            "total_waiting_tables": -1,
        }

        # 历史记录
        history = load_history()
        self.history = history["records"]
        self.max_history = history.get("max_records", 500)

        # 线程控制
        self.running = False
        self.thread = None
        self.lock = threading.Lock()

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._poll_loop, daemon=True)
        self.thread.start()
        log.info(f"✅ 监控已启动, 轮询间隔: {self.api_config.get('poll_interval_seconds', 15)}秒")

    def stop(self):
        self.running = False

    def _poll_loop(self):
        while self.running:
            try:
                self._fetch_queue_status()
            except Exception as e:
                with self.lock:
                    self.current_status["connected"] = False
                    self.current_status["last_error"] = str(e)
                    self.current_status["error_count"] += 1
                log.error(f"轮询失败: {e}")

            # 等待下一次轮询
            interval = self.api_config.get("poll_interval_seconds", 15)
            for _ in range(interval):
                if not self.running:
                    return
                time.sleep(1)

    def _fetch_queue_status(self):
        """调用寿司郎排队 API 获取最新状态"""
        base_url = self.api_config["base_url"]
        path = self.api_config["queue_status_path"]
        store_id = self.api_config["store_id"]
        url = f"{base_url.rstrip('/')}{path}"

        headers = self._build_headers()
        params = self._build_params(store_id)

        log.debug(f"请求: GET {url} params={params}")

        # 发送请求 (同时支持 GET 和 POST, 根据抓包结果调整)
        method = self.api_config.get("method", "GET").upper()
        if method == "POST":
            body = self.api_config.get("request_body", {})
            resp = requests.post(url, json=body, headers=headers, timeout=10)
        else:
            resp = requests.get(url, params=params, headers=headers, timeout=10)

        if resp.status_code != 200:
            raise Exception(f"HTTP {resp.status_code}: {resp.text[:200]}")

        data = resp.json()
        self._parse_response(data)

    def _build_headers(self):
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }

        # Auth token
        token = self.auth_config.get("token", "")
        if token:
            headers["Authorization"] = f"Bearer {token}"

        # Cookie
        cookie = self.auth_config.get("cookie", "")
        if cookie:
            headers["Cookie"] = cookie

        # 自定义 headers
        custom_headers = self.auth_config.get("headers", {})
        for k, v in custom_headers.items():
            if v and not k.startswith("_"):
                headers[k] = v

        return headers

    def _build_params(self, store_id):
        """构建请求参数"""
        extra_params = self.api_config.get("request_params", {})
        params = {"storeId": store_id, **extra_params}
        # 过滤掉空值和注释
        return {k: v for k, v in params.items() if v and not k.startswith("_")}

    def _parse_response(self, data):
        """
        解析 API 响应。
        由于不同门店/地区的 API 响应格式可能不同,
        这里使用 config.json 中的 mapping 来提取字段。
        """
        mapping = self.api_config.get("response_mapping", {})

        # 默认 mapping
        default_mapping = {
            "current_number": "currentNumber",   # 当前叫到的号
            "store_name": "storeName",            # 门店名称
            "tables_ahead": "tablesAhead",        # 前面还有多少桌
            "estimated_wait": "estimatedWaitMinutes",  # 预估等待时间(分钟)
            "total_waiting": "totalWaitingTables",# 总排队桌数
        }

        mapping = {**default_mapping, **mapping}

        def get_nested(obj, path):
            """从嵌套字典中按路径取值: 'data.currentNumber'"""
            for key in path.split("."):
                if obj is None:
                    return None
                if isinstance(obj, dict):
                    obj = obj.get(key)
                else:
                    return None
            return obj

        store_name = get_nested(data, mapping.get("store_name", "")) or "未知门店"
        current = get_nested(data, mapping.get("current_number", ""))
        tables_ahead = get_nested(data, mapping.get("tables_ahead", ""))
        est_wait = get_nested(data, mapping.get("estimated_wait", ""))
        total_waiting = get_nested(data, mapping.get("total_waiting", ""))

        # 更新当前状态
        with self.lock:
            now = datetime.now().isoformat()
            self.current_status.update({
                "connected": True,
                "last_update": now,
                "last_error": None,
                "store_name": str(store_name),
                "current_number": str(current) if current else "---",
                "tables_ahead": int(tables_ahead) if tables_ahead is not None else -1,
                "estimated_wait_minutes": int(est_wait) if est_wait is not None else -1,
                "total_waiting_tables": int(total_waiting) if total_waiting is not None else -1,
            })

            # 计算排队速度 (桌/小时)
            self._calc_queue_speed(current, tables_ahead)

            # 添加到历史记录
            self.history.append({
                "time": now,
                "current_number": str(current) if current else "---",
                "tables_ahead": int(tables_ahead) if tables_ahead is not None else -1,
                "estimated_wait": int(est_wait) if est_wait is not None else -1,
            })

            # 裁剪历史记录
            if len(self.history) > self.max_history:
                self.history = self.history[-self.max_history:]

            # 定期保存（每 5 条）
            if len(self.history) % 5 == 0:
                save_history({"records": self.history, "max_records": self.max_history})

        log.info(
            f"🍣 {store_name} | 当前叫号:{current} | "
            f"前面:{tables_ahead}桌 | 预计等待:{est_wait}分钟 | "
            f"总排队:{total_waiting}桌"
        )

    def _calc_queue_speed(self, current_number, tables_ahead):
        """根据最近的历史记录估算叫号速度"""
        if len(self.history) < 5:
            return

        # 取最近 5 条记录
        recent = self.history[-5:]

        try:
            # 计算叫号速度: 用 current_number 的变化
            first_num = int(recent[0]["current_number"])
            last_num = int(recent[-1]["current_number"])

            # 时间差(秒)
            t1 = datetime.fromisoformat(recent[0]["time"])
            t2 = datetime.fromisoformat(recent[-1]["time"])
            seconds = (t2 - t1).total_seconds()

            if seconds > 0 and last_num >= first_num:
                speed = (last_num - first_num) / seconds * 3600
                self.current_status["queue_speed_per_hour"] = round(speed, 1)
        except (ValueError, TypeError):
            pass

    def get_status(self):
        """获取当前状态 (线程安全)"""
        with self.lock:
            return dict(self.current_status)

    def get_history(self):
        """获取历史记录副本"""
        with self.lock:
            return list(self.history)

    def update_my_number(self, number):
        """更新我的取号号码"""
        with self.lock:
            self.current_status["my_number"] = number
            self.user_config["my_queue_number"] = number
            # 保存到配置
            config = load_config()
            config["user"]["my_queue_number"] = number
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(config, f, ensure_ascii=False, indent=2)


# ============================================================
# Flask Web 服务
# ============================================================
config = load_config()
monitor = QueueMonitor(config)

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")
CORS(app, resources={r"/api/*": {"origins": ["http://localhost:8888", "http://127.0.0.1:8888"]}})


@app.route("/")
def index():
    """仪表盘主页"""
    # 将 API Key 注入到页面中，供前端携带调用配置写入接口
    html_path = STATIC_DIR / "dashboard.html"
    try:
        content = html_path.read_text(encoding="utf-8")
        inject = f'<script>window.__SUSHIRO_API_KEY__="{API_KEY}";</script></head>'
        content = content.replace('</head>', inject, 1)
        return content, 200, {'Content-Type': 'text/html; charset=utf-8'}
    except FileNotFoundError:
        return "dashboard.html not found", 404


@app.route("/api/status")
def api_status():
    """获取当前排队状态"""
    return jsonify(monitor.get_status())


@app.route("/api/history")
def api_history():
    """获取历史记录"""
    return jsonify(monitor.get_history())


@app.route("/api/config", methods=["GET", "POST"])
def api_config():
    """读取/更新配置"""
    if request.method == "POST":
        # 鉴权: 需要携带启动时生成的 API Key
        provided_key = request.headers.get("X-API-Key", "")
        if provided_key != API_KEY:
            log.warning(f"非法配置写入尝试 (来自 {request.remote_addr})")
            return jsonify({"ok": False, "error": "未授权: 请提供正确的 X-API-Key"}), 401

        new_config = request.json
        if not isinstance(new_config, dict):
            return jsonify({"ok": False, "error": "请求体必须是 JSON 对象"}), 400

        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(new_config, f, ensure_ascii=False, indent=2)
        # 更新当前 monitor 的配置
        global config, monitor
        config = new_config
        # 重启 monitor 线程
        monitor.stop()
        monitor = QueueMonitor(config)
        monitor.start()
        log.info("配置已更新 (通过 API Key 鉴权)")
        return jsonify({"ok": True})

    # GET: 返回配置 (隐藏敏感信息)
    safe_config = json.loads(json.dumps(config))
    if "token" in safe_config.get("auth", {}):
        safe_config["auth"]["token"] = "***已隐藏***"
    if "cookie" in safe_config.get("auth", {}):
        safe_config["auth"]["cookie"] = "***已隐藏***"
    return jsonify(safe_config)


@app.route("/api/update-my-number", methods=["POST"])
def api_update_my_number():
    """更新我的取号号码"""
    data = request.json
    number = data.get("number", "")
    monitor.update_my_number(number)
    return jsonify({"ok": True})


@app.route("/api/alerts")
def api_alerts():
    """检查是否需要提醒"""
    status = monitor.get_status()
    alert_config = config.get("alerts", {})

    tables_ahead = status.get("tables_ahead", -1)
    est_wait = status.get("estimated_wait_minutes", -1)
    travel_time = alert_config.get("travel_time_minutes", 15)

    alerts = []

    if tables_ahead >= 0:
        leave_now = alert_config.get("tables_ahead_leave_now", 5)
        warning = alert_config.get("tables_ahead_warning", 10)

        if tables_ahead <= leave_now:
            alerts.append({
                "level": "urgent",
                "message": f"🚨 前面只剩 {tables_ahead} 桌! 必须立刻出发!",
                "title": "立刻出发!",
            })
        elif tables_ahead <= warning:
            alerts.append({
                "level": "warning",
                "message": f"⚠️ 前面还有 {tables_ahead} 桌, 预计 {est_wait} 分钟, 建议准备出发",
                "title": "准备出发",
            })

    # 检查等待时间是否接近 (如果有预估)
    if est_wait > 0 and est_wait <= travel_time + 5:
        alerts.append({
            "level": "warning",
            "message": f"⏰ 预计等待 {est_wait} 分钟, 路程需要 {travel_time} 分钟, 该出发了!",
            "title": "时间紧迫",
        })

    return jsonify({"alerts": alerts})


def main():
    """主函数"""
    print("=" * 55)
    print("  🍣 寿司郎排队监控系统  v1.0")
    print("=" * 55)
    print()
    print(f"  📡 仪表盘地址: http://localhost:{PORT}")
    print(f"  🔑 API Key:    {API_KEY}")
    print(f"  ⚙️  配置文件:   {CONFIG_FILE}")
    print(f"  🏪 门店ID:     {config['api'].get('store_id', '未设置')}")
    print(f"  🔄 轮询间隔:   {config['api'].get('poll_interval_seconds', 15)}秒")
    print()
    print("  按 Ctrl+C 停止")
    print("=" * 55)
    print()

    # 启动监控
    monitor.start()

    # 启动 Web 服务
    try:
        app.run(host="127.0.0.1", port=PORT, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        monitor.stop()
        log.info("👋 监控已停止")
        save_history({"records": monitor.history, "max_records": monitor.max_history})


if __name__ == "__main__":
    main()
