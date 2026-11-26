import argparse
import fcntl
import json
import os
import secrets
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


CONFIG_DIR = Path.home() / ".config/openmausbot/feishu-gateway"


@dataclass(frozen=True)
class PrivateText:
    event_id: str
    message_id: str
    open_id: str
    text: str
    created_at: float | None = None


def private_text(envelope, app_id):
    if not isinstance(envelope, dict):
        return None
    header = envelope.get("header")
    event = envelope.get("event")
    if not isinstance(header, dict) or not isinstance(event, dict):
        return None
    if header.get("app_id") != app_id or header.get("event_type") != "im.message.receive_v1":
        return None

    message = event.get("message")
    sender = event.get("sender")
    if not isinstance(message, dict) or not isinstance(sender, dict):
        return None
    if (message.get("chat_type"), message.get("message_type"), sender.get("sender_type")) != ("p2p", "text", "user"):
        return None
    sender_id = sender.get("sender_id")
    if not isinstance(sender_id, dict):
        return None
    try:
        content = json.loads(message["content"])
    except (ValueError, TypeError, KeyError):
        return None
    if not isinstance(content, dict):
        return None
    fields = (header.get("event_id"), message.get("message_id"), sender_id.get("open_id"), content.get("text"))
    if not all(isinstance(value, str) and value.strip() for value in fields):
        return None
    created_ms = message.get("create_time")
    created_at = None
    if isinstance(created_ms, str) and created_ms.isascii() and created_ms.isdigit() and len(created_ms) <= 14:
        created_at = int(created_ms) / 1000
    return PrivateText(*fields, created_at)


class ReceiveProbe:
    def __init__(self, app_id, directory):
        self.app_id = app_id
        self.directory = directory
        self.challenge = "网关验证 " + secrets.token_hex(6)
        self.recorded = False

    def receive(self, envelope):
        message = private_text(envelope, self.app_id)
        if message is None or self.recorded or message.text != self.challenge:
            return
        receipt = {
            "appId": self.app_id,
            "eventId": message.event_id,
            "messageId": message.message_id,
            "senderOpenId": message.open_id,
            "receivedAt": datetime.now(timezone.utc).isoformat(),
        }
        destination = self.directory / "receive-probe.json"
        with tempfile.NamedTemporaryFile(mode="w", dir=self.directory, delete=False) as staged:
            try:
                json.dump(receipt, staged)
                staged.flush()
                os.fsync(staged.fileno())
                os.replace(staged.name, destination)
            finally:
                Path(staged.name).unlink(missing_ok=True)
        self.recorded = True
        print("已收到验证私聊，回执已保存。可按 Ctrl+C 结束。", flush=True)


def listen(credentials, on_event):
    import lark_oapi as lark

    def receive(data):
        on_event(json.loads(lark.JSON.marshal(data)))

    handler = lark.EventDispatcherHandler.builder("", "").register_p2_im_message_receive_v1(receive).build()
    delay = 5
    while True:
        started = time.monotonic()
        try:
            client = lark.ws.Client(credentials["appId"], credentials["appSecret"],
                                    event_handler=handler, log_level=lark.LogLevel.ERROR)
            client.on_reconnecting = lambda: print("正在恢复长连接。", flush=True)
            client.on_reconnected = lambda: print("长连接已恢复。", flush=True)
            client.start()
        except Exception as error:
            print(f"长连接退出（{type(error).__name__}）。", flush=True)
        if time.monotonic() - started >= 60:
            delay = 5
        print(f"{delay} 秒后重新连接。", flush=True)
        time.sleep(delay)
        delay = min(delay * 2, 60)


def run_relay(args, credentials):
    import lark_oapi as lark
    from lark_oapi.api.im.v1 import ReplyMessageRequest, ReplyMessageRequestBody
    from feishu_relay import Harness, Relay, RelayError

    app = credentials["appId"]
    receipt_path = CONFIG_DIR / "receive-probe.json"
    receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    if args.allow_probed_sender:
        if not args.thread or receipt.get("appId") != app or not receipt.get("senderOpenId"):
            raise SystemExit("需要此应用的入站回执及 --thread。")
        routes = {receipt["senderOpenId"]: args.thread}
    else:
        routes = json.loads(args.routes.read_text())
    if (not isinstance(routes, dict)
            or not all(isinstance(user, str) and user.startswith("ou_")
                       and isinstance(thread, str) and thread for user, thread in routes.items())
            or len(set(routes.values())) != len(routes)):
        raise SystemExit("白名单应将每个 open_id 指向独立的目标会话。")

    harness = Harness(args.port, args.bot)
    harness.verify()
    api = lark.Client.builder().app_id(app).app_secret(credentials["appSecret"]).timeout(10).build()

    def reply(message_id, text, send_id):
        body = ReplyMessageRequestBody.builder().msg_type("text").uuid(send_id).content(
            json.dumps({"text": text}, ensure_ascii=False)).build()
        request = ReplyMessageRequest.builder().message_id(message_id).request_body(body).build()
        response = api.im.v1.message.reply(request)
        if not response.success():
            if response.raw and (response.raw.status_code == 429 or response.raw.status_code >= 500):
                raise ConnectionError(f"飞书 API {response.code}")
            raise RelayError(f"飞书回复 API 返回 {response.code}")
        if not response.data or not response.data.message_id:
            raise ConnectionError("飞书回复回执缺少消息编号")

    relay = Relay(CONFIG_DIR / "deliveries.sqlite3", app, routes, harness, reply)

    if args.prepare_ask:
        count = relay.prepare_probed_thread(receipt["senderOpenId"])
        print(f"测试会话已设为 Ask，{count} 条因权限被拒的私聊已恢复排队。", flush=True)

    def receive(envelope):
        message = private_text(envelope, app)
        if message is None:
            return "filtered"
        if message.message_id == receipt.get("messageId"):
            return "probe"
        return relay.accept(message)

    if not routes:
        print("[启动] 白名单人数为 0，正在等待飞书私聊。", flush=True)
        listen(credentials, receive)
        return

    worker = threading.Thread(target=relay.work, daemon=True)
    worker.start()
    print("固定 Bot 与白名单已配置，正在连接飞书。", flush=True)
    try:
        listen(credentials, receive)
    finally:
        relay.stop.set()
        worker.join(timeout=12)


def main():
    parser = argparse.ArgumentParser(description="飞书私聊网关")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe", action="store_true", help="只接收一次性验证短语")
    mode.add_argument("--allow-probed-sender", action="store_true", help="仅授权本地入站回执中的测试账号")
    mode.add_argument("--routes", type=Path, help="本地白名单 JSON，键为 open_id，值为会话 ID；{} 拒绝全部私聊")
    parser.add_argument("--thread", help="验证账号专用的固定会话 ID")
    parser.add_argument("--port", type=int, help="目标 harness 的回环端口")
    parser.add_argument("--bot", help="固定 Bot ID")
    parser.add_argument("--prepare-ask", action="store_true",
                        help="将已验证账号的指定会话设为 Ask，重试该会话因权限被拒且未受理的消息")
    args = parser.parse_args()
    if args.prepare_ask and not args.allow_probed_sender:
        parser.error("--prepare-ask 需要 --allow-probed-sender")
    if not args.probe and (not args.port or not 1 <= args.port <= 65535 or not args.bot):
        parser.error("转发模式需要 --port 和 --bot")
    os.umask(0o077)
    credentials = json.loads((CONFIG_DIR / "credentials.json").read_text())
    with (CONFIG_DIR / "gateway.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("已有网关或验证探针在运行。")
        try:
            if args.probe:
                probe = ReceiveProbe(credentials["appId"], CONFIG_DIR)
                print(f"请在飞书私聊中发送：{probe.challenge}", flush=True)
                listen(credentials, probe.receive)
            else:
                run_relay(args, credentials)
        except KeyboardInterrupt:
            return
        except OSError as error:
            raise SystemExit(f"无法连接或读写本地资源：{error.strerror}")


if __name__ == "__main__":
    main()
