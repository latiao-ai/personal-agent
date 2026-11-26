import asyncio
import hashlib
import json
import os
import sys
import tempfile
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from importlib.metadata import version
from unittest.mock import patch

import lark_oapi as lark

import feishu_gateway


def event_fields(envelope):
    header = envelope.get("header") if isinstance(envelope, dict) else None
    if not isinstance(header, dict):
        return {}
    kind = header.get("event_type")
    fields = {"kind": "receive" if kind == "im.message.receive_v1" else "other"}
    event_id = header.get("event_id")
    if isinstance(event_id, str) and event_id:
        fields["event_hash"] = hashlib.sha256(event_id.encode("utf-8", "surrogatepass")).hexdigest()[:12]
    return fields


@contextmanager
def trace_events(record):
    dispatcher = lark.EventDispatcherHandler
    dispatch = dispatcher._do_without_validation
    listen = feishu_gateway.listen
    handle_frame = lark.ws.Client._handle_data_frame
    current_event = ContextVar("feishu_trace_event", default=None)

    async def traced_frame(client, frame):
        token = current_event.set(None)
        try:
            await handle_frame(client, frame)
            fields = current_event.get()
            if fields is not None:
                # lark-oapi 1.8.0 将同一 Frame 的 payload 替换成回执，并等待写入返回。
                code = json.loads(frame.payload)["code"]
                record("ack_written", **fields, code=code)
        except Exception as error:
            record("frame_error", **(current_event.get() or {}), error=type(error).__name__)
            raise
        finally:
            current_event.reset(token)

    def traced_dispatch(handler, payload):
        try:
            fields = event_fields(json.loads(payload))
        except (ValueError, TypeError, RecursionError):
            fields = {}
        current_event.set(fields)
        record("dispatch", **fields)
        try:
            result = dispatch(handler, payload)
        except Exception as error:
            record("dispatch_error", **fields, error=type(error).__name__)
            raise
        record("dispatch_return", **fields)
        return result

    def traced_listen(credentials, on_event):
        def receive(envelope):
            fields = event_fields(envelope)
            record("callback", **fields)
            result = on_event(envelope)
            record("disposition", **fields, result=result)
            return result

        return listen(credentials, receive)

    with (patch.object(lark.ws.Client, "_handle_data_frame", traced_frame),
          patch.object(dispatcher, "_do_without_validation", traced_dispatch),
          patch.object(feishu_gateway, "listen", traced_listen)):
        yield


def main():
    if version("lark-oapi") != "1.8.0":
        raise SystemExit("此断线验证使用项目锁定的 lark-oapi 1.8.0。")
    if "--allow-probed-sender" not in sys.argv:
        raise SystemExit("请使用已验证账号和隔离 Bot 的启动参数。")

    original_connect = lark.ws.Client._connect
    first_socket = None
    dropped = False
    recovered = False
    with tempfile.NamedTemporaryFile(mode="w", prefix="omb-feishu-reconnect-", suffix=".jsonl",
                                     delete=False) as evidence:
        def record(event, message=None, **fields):
            try:
                print(json.dumps({"event": event, "at": datetime.now(timezone.utc).isoformat(),
                                  "pid": os.getpid(), **fields}), file=evidence, flush=True)
            except OSError as error:
                print(f"[验证] 记录写入失败（{type(error).__name__}）。", file=sys.stderr, flush=True)
            if message:
                print(message, flush=True)

        def drop(client, socket):
            nonlocal dropped
            if client._conn is socket and client._conn is not None:
                dropped = True
                record("disconnect", "[验证] 已中断本进程的飞书连接，等待 SDK 自动恢复。")
                socket.transport.abort()

        async def connect(client):
            nonlocal first_socket, recovered
            await original_connect(client)
            socket = client._conn
            if socket is None:
                return
            if first_socket is None:
                first_socket = socket
                record("connected", "[验证] 已建立第一条飞书连接。")
                asyncio.get_running_loop().call_later(2, drop, client, socket)
            elif dropped and socket is not first_socket and not recovered:
                recovered = True
                record("reconnected", "[验证] 飞书已重新连接。现在请连续发送三条测试私聊。")

        print(f"连接验证记录：{evidence.name}", flush=True)
        with patch.object(lark.ws.Client, "_connect", connect), trace_events(record):
            feishu_gateway.main()


if __name__ == "__main__":
    main()
