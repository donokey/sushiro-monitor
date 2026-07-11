"""
寿司郎排队监控 - 抓包辅助脚本 (mitmproxy addon)

使用方法:
    mitmweb -s capture_proxy.py --set block_global=false

或在命令行直接运行 mitmdump:
    mitmdump -s capture_proxy.py

功能:
    - 拦截所有请求，自动识别疑似寿司郎 API 的请求
    - 将匹配的请求详情保存到 captured_apis/ 目录
    - 在控制台高亮打印请求/响应
"""

import json
import os
import re
from datetime import datetime
from mitmproxy import http, ctx


# ============================================================
# 配置: 根据你所在的地区修改关键词
# ============================================================
# 寿司郎相关关键词 (小程序可能用的域名/路径关键词)
KEYWORDS = [
    "sushiro", "sushi", "akindo",
    "queue", "waiting", "line", "number",
    "排队", "取号", "叫号",
    "store", "shop", "branch",
    "booking", "reservation",
    "wxapp", "miniapp", "wechat",
    "maicai", "meituan",  # 可能用的第三方服务
]

# 要忽略的静态资源
IGNORE_EXTENSIONS = {".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".woff", ".woff2", ".ttf", ".ico", ".map"}

# 输出目录
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "captured_apis")


def load_output_dir():
    os.makedirs(OUTPUT_DIR, exist_ok=True)


def is_sushiro_related(url: str) -> bool:
    """判断 URL 是否可能与寿司郎排队有关"""
    url_lower = url.lower()

    # 检查是否包含任何关键词
    for kw in KEYWORDS:
        if kw.lower() in url_lower:
            return True
    return False


def is_static_resource(url: str) -> bool:
    """判断是否为静态资源"""
    url_lower = url.lower()
    for ext in IGNORE_EXTENSIONS:
        if ext in url_lower:
            return True
    return False


def sanitize_filename(url: str) -> str:
    """将 URL 转为安全的文件名"""
    safe = re.sub(r'[^a-zA-Z0-9一-鿿\-_=]', '_', url)
    return safe[:150]  # 限制长度


def format_headers(headers) -> str:
    """格式化请求/响应头"""
    lines = []
    for k, v in headers.items():
        # 掩码敏感信息
        if k.lower() in ("authorization", "cookie", "set-cookie", "token", "x-auth-token"):
            v = v[:20] + "..." if len(v) > 20 else v
        lines.append(f"  {k}: {v}")
    return "\n".join(lines)


def save_request_detail(flow: http.HTTPFlow):
    """保存请求详情到文件"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    filename = f"{timestamp}_{sanitize_filename(flow.request.pretty_url)}.json"
    filepath = os.path.join(OUTPUT_DIR, filename)

    request_body = None
    if flow.request.content:
        try:
            request_body = flow.request.content.decode("utf-8", errors="replace")
        except Exception:
            request_body = f"[binary {len(flow.request.content)} bytes]"

    response_body = None
    if flow.response and flow.response.content:
        try:
            response_body = flow.response.content.decode("utf-8", errors="replace")
            # 尝试格式化 JSON
            try:
                response_body = json.dumps(json.loads(response_body), ensure_ascii=False, indent=2)
            except (json.JSONDecodeError, TypeError):
                pass
        except Exception:
            response_body = f"[binary {len(flow.response.content)} bytes]"

    detail = {
        "url": flow.request.pretty_url,
        "method": flow.request.method,
        "request_headers": dict(flow.request.headers),
        "request_body": request_body,
        "response_status": flow.response.status_code if flow.response else None,
        "response_headers": dict(flow.response.headers) if flow.response else None,
        "response_body": response_body,
    }

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(detail, f, ensure_ascii=False, indent=2)

    ctx.log.info(f"💾 已保存: {filepath}")


class SushiroCapture:
    """寿司郎 API 抓包插件"""

    def load(self, loader):
        load_output_dir()
        ctx.log.info("=" * 60)
        ctx.log.info("🍣 寿司郎排队 API 抓包工具已启动")
        ctx.log.info(f"   保存目录: {OUTPUT_DIR}")
        ctx.log.info("   请在微信中打开寿司郎小程序，查看排队页面")
        ctx.log.info("   匹配到的 API 请求会自动保存到 captured_apis/ 目录")
        ctx.log.info("=" * 60)

    def response(self, flow: http.HTTPFlow):
        url = flow.request.pretty_url

        # 跳过静态资源
        if is_static_resource(url):
            return

        # 检查是否与寿司郎相关
        if is_sushiro_related(url):
            status = flow.response.status_code if flow.response else "N/A"

            # 高亮输出到控制台
            ctx.log.info("-" * 60)
            ctx.log.info(f"🍣 [{flow.request.method}] {url}")
            ctx.log.info(f"   状态码: {status}")
            ctx.log.info(f"   请求头:")
            ctx.log.info(format_headers(flow.request.headers))
            if flow.response:
                ctx.log.info(f"   响应类型: {flow.response.headers.get('content-type', 'unknown')}")

            # 如果是 JSON 响应,直接打印到控制台
            if flow.response and flow.response.content:
                try:
                    body = flow.response.content.decode("utf-8", errors="replace")
                    # 截取不超长
                    if len(body) < 3000:
                        ctx.log.info(f"   响应体: {body}")
                    else:
                        ctx.log.info(f"   响应体(前3000字符): {body[:3000]}...")
                except Exception:
                    pass

            # 保存到文件
            save_request_detail(flow)


addons = [SushiroCapture()]
