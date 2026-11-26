import hashlib
import http.client
import json
import sqlite3
import threading
import time
import uuid
from contextlib import closing
from datetime import datetime
from urllib.parse import quote


class RelayError(Exception):
    pass


class Harness:
    def __init__(self, port, bot):
        self.port = port
        self.bot = bot
        self.base = "/api/bots/" + quote(bot, safe="")

    def call(self, path, body=None, *, method=None):
        with closing(http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)) as conn:
            conn.request(method or ("GET" if body is None else "POST"), path,
                         None if body is None else json.dumps(body),
                         {"Content-Type": "application/json"})
            response = conn.getresponse()
            raw = response.read()
            if response.status >= 500 or response.status == 429:
                raise ConnectionError(f"harness HTTP {response.status}")
            if response.status >= 300:
                try:
                    code = json.loads(raw).get("code")
                except (ValueError, AttributeError):
                    code = None
                if code == "guarded_busy":
                    raise ConnectionError("guarded_busy")
                raise RelayError(f"harness HTTP {response.status} {code or ''}")
            return json.loads(raw)

    def verify(self):
        caps = self.call("/api/health").get("capabilities", {})
        if not all(caps.get(key) == 1 for key in ("guardedMessages", "guardedRequests")):
            raise RelayError("harness 缺少 guardedMessages 或 guardedRequests")

    def prepare_ask(self, thread):
        result = self.call(f"{self.base}/tasks/{quote(thread, safe='')}",
                           {"approvalMode": "ask"}, method="PATCH")
        task = result.get("task", {})
        if (result.get("bot", {}).get("id") != self.bot or task.get("threadId") != thread
                or task.get("approvalMode") != "ask" or task.get("autoApprove")
                or task.get("alwaysAllow")):
            raise RelayError("未取得目标会话的 Ask 权限回执")

    def submit(self, row):
        thread = quote(row["thread"], safe="")
        leaf = self.call(f"/api/threads/{thread}/messages?limit=1")["activeLeafId"]
        result = self.call(self.base + "/messages/guarded", {
            "threadId": row["thread"], "text": row["body"], "sendId": row["send_id"],
            "expectedApprovalMode": "ask", "expectedActiveLeafId": leaf,
        })
        return result["message"]["id"]

    def result(self, row):
        thread = quote(row["thread"], safe="")
        result = self.call(f'{self.base}/requests/{row["send_id"]}?threadId={thread}')
        if result["messageId"] != row["source"]:
            raise RelayError("请求回执不匹配")
        if result["phase"] in ("working", "waiting"):
            return None
        if result["phase"] == "settled":
            for message in reversed(result["messages"]):
                if (message.get("role") == "bot" and message.get("kind") == "text"
                        and message.get("requestMessageId") == row["source"]
                        and message.get("turnTerminal") and message.get("turnSucceeded")
                        and message.get("text")):
                    return message["text"]
        raise RelayError("未取得该请求的最终回复")


class Relay:
    def __init__(self, database, app, routes, harness, reply):
        self.database = database
        self.app = app
        self.routes = routes
        self.harness = harness
        self.reply = reply
        self.binding = f"{harness.port}/{harness.bot}"
        self.stop = threading.Event()
        with closing(self.connect()) as db:
            db.execute("""CREATE TABLE IF NOT EXISTS deliveries (
                seq INTEGER PRIMARY KEY, app TEXT NOT NULL, event TEXT NOT NULL,
                message TEXT NOT NULL, sender TEXT NOT NULL, binding TEXT NOT NULL,
                thread TEXT NOT NULL, send_id TEXT NOT NULL, body TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'queued', source TEXT, answer TEXT,
                first_reply_at REAL, created_at REAL, received_at REAL NOT NULL, accepted_at REAL, done_at REAL,
                next_try REAL NOT NULL DEFAULT 0,
                reason TEXT, UNIQUE(app,event), UNIQUE(app,message))""")

            db.execute("""CREATE TABLE IF NOT EXISTS conversations (
                app TEXT, binding TEXT, thread TEXT, sender TEXT NOT NULL,
                PRIMARY KEY(app,binding,thread))""")
            db.execute("BEGIN")
            for sender, thread in routes.items():
                key = (app, self.binding, thread)
                db.execute("INSERT OR IGNORE INTO conversations VALUES (?,?,?,?)", (*key, sender))
                owner = db.execute("SELECT sender FROM conversations WHERE app=? AND binding=? AND thread=?", key).fetchone()
                if owner["sender"] != sender:
                    raise RelayError("此会话已绑定其他飞书账号，请使用独立会话")
            db.commit()

    def connect(self):
        db = sqlite3.connect(self.database, isolation_level=None)
        db.row_factory = sqlite3.Row
        return db

    def prepare_probed_thread(self, sender):
        thread = self.routes[sender]
        self.harness.prepare_ask(thread)
        with closing(self.connect()) as db:
            updated = db.execute("""UPDATE deliveries SET state='queued',reason=NULL,next_try=0
                WHERE app=? AND binding=? AND sender=? AND thread=?
                AND state='review' AND reason='harness HTTP 409 guarded_permissions'
                AND accepted_at IS NULL AND source IS NULL AND answer IS NULL
                AND first_reply_at IS NULL AND done_at IS NULL""",
                (self.app, self.binding, sender, thread))
            return updated.rowcount

    def accept(self, message):
        thread = self.routes.get(message.open_id)
        if thread is None:
            tag = hashlib.sha256(message.open_id.encode()).hexdigest()[:12]
            received = datetime.now().astimezone().isoformat(timespec="seconds")
            sent = (datetime.fromtimestamp(message.created_at).astimezone().isoformat(timespec="seconds")
                    if message.created_at is not None else "未知")
            event = hashlib.sha256(message.event_id.encode()).hexdigest()[:12]
            print(f"[消息] 拒绝白名单外私聊 发送={sent} 收到={received} event_hash={event} sender_hash={tag}", flush=True)
            return "denied"
        send_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"feishu/{self.app}/{message.message_id}"))
        with closing(self.connect()) as db:
            cursor = db.execute("""INSERT OR IGNORE INTO deliveries
                (app,event,message,sender,binding,thread,send_id,body,created_at,received_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)""", (self.app, message.event_id, message.message_id,
                message.open_id, self.binding, thread, send_id, message.text, message.created_at, time.time()))
        if cursor.rowcount:
            print(f"已记录私聊 request={send_id}", flush=True)
            return "queued"
        return "duplicate"

    def advance(self, db, row):
        seq = row["seq"]
        if self.routes.get(row["sender"]) != row["thread"]:
            raise RelayError("白名单或目标会话已变更")
        if row["state"] == "queued":
            source = self.harness.submit(row)
            db.execute("UPDATE deliveries SET state='accepted',source=?,accepted_at=? WHERE seq=?",
                       (source, time.time(), seq))
        elif row["state"] == "accepted":
            answer = self.harness.result(row)
            if answer is None:
                return False
            db.execute("UPDATE deliveries SET state='reply',answer=? WHERE seq=?", (answer, seq))
        else:
            now = time.time()
            if row["first_reply_at"] is None:
                db.execute("UPDATE deliveries SET first_reply_at=? WHERE seq=?", (now, seq))
            elif not 0 <= now - row["first_reply_at"] < 600:
                raise RelayError("飞书回复结果待人工核对，已停止重发")
            self.reply(row["message"], row["answer"], row["send_id"])
            db.execute("UPDATE deliveries SET state='done',body='',answer=NULL,done_at=? WHERE seq=?",
                       (time.time(), seq))
            print(f'已回复原私聊 request={row["send_id"]}', flush=True)
        return True

    def work(self):
        backoff = {}
        with closing(self.connect()) as db:
            while not self.stop.is_set():
                row = db.execute("""SELECT * FROM deliveries WHERE seq IN (
                    SELECT MIN(seq) FROM deliveries WHERE app=? AND binding=?
                    AND state IN ('queued','accepted','reply') GROUP BY thread)
                    AND next_try<=? ORDER BY seq LIMIT 1""",
                    (self.app, self.binding, time.time())).fetchone()
                if row is None:
                    self.stop.wait(0.15)
                    continue
                try:
                    if not self.advance(db, row):
                        db.execute("UPDATE deliveries SET next_try=? WHERE seq=?", (time.time() + 0.4, row["seq"]))
                    backoff.pop(row["seq"], None)
                except RelayError as error:
                    backoff.pop(row["seq"], None)
                    db.execute("UPDATE deliveries SET state='review',reason=? WHERE seq=?", (str(error), row["seq"]))
                    print(f'需核对 request={row["send_id"]} {error}', flush=True)
                    if str(error) == "harness HTTP 409 guarded_permissions":
                        print("请检查指定会话是否为 Ask，且未启用自动或记忆授权。", flush=True)
                except Exception as error:
                    print(f'等待重试 request={row["send_id"]} {type(error).__name__}', flush=True)
                    delay = backoff.get(row["seq"], 1)
                    backoff[row["seq"]] = min(delay * 2, 30)
                    db.execute("UPDATE deliveries SET next_try=? WHERE seq=?", (time.time() + delay, row["seq"]))
