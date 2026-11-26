import json
import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock

from feishu_gateway import private_text
from feishu_relay import Harness, Relay, RelayError


class RelayTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "queue.sqlite3"
        self.harness = Harness(19896, "fixture-bot")
        self.harness.call = Mock(side_effect=self.api)
        self.turns = {}
        self.reply = Mock()
        self.routes = {"ou_fixture": "thread-1"}
        self.relay = self.start_relay()

    def start_relay(self):
        return Relay(self.path, "fixture", self.routes, self.harness, self.reply)

    def api(self, path, body=None):
        if path == "/api/threads/thread-1/messages?limit=1":
            return {"activeLeafId": None}
        if path == "/api/bots/fixture-bot/messages/guarded":
            self.assertEqual(body["threadId"], "thread-1")
            self.assertEqual(body["expectedApprovalMode"], "ask")
            source = "source-" + body["sendId"]
            self.turns[body["sendId"]] = body["text"]
            return {"message": {"id": source}}
        turn = path.split("/requests/")[1].split("?")[0]
        source = "source-" + turn
        return {"phase": "settled", "messageId": source, "messages": [
            {"role": "bot", "kind": "text", "text": self.turns[turn],
             "turnTerminal": True, "turnSucceeded": True, "requestMessageId": source},
            {"role": "bot", "kind": "text", "text": "foreign", "turnTerminal": True,
             "turnSucceeded": True, "requestMessageId": "another"},
        ]}

    def event(self, number, user="ou_fixture", chat="p2p"):
        return {"header": {"event_type": "im.message.receive_v1", "app_id": "fixture", "event_id": str(number)},
                "event": {"sender": {"sender_type": "user", "sender_id": {"open_id": user}},
                          "message": {"chat_type": chat, "message_type": "text", "message_id": f"om_{number}",
                                      "content": json.dumps({"text": f"私聊 {number}"})}}}

    def test_receive_restart_and_order(self):
        for i in (1, 1, 2, 3):
            self.relay.accept(private_text(self.event(i), "fixture"))
        self.relay.accept(private_text(self.event(4, user="ou_other"), "fixture"))
        self.assertIsNone(private_text(self.event(5, chat="group"), "fixture"))
        self.relay = self.start_relay()
        with closing(self.relay.connect()) as db:
            for _ in range(9):
                row = db.execute("SELECT * FROM deliveries WHERE state!='done' ORDER BY seq LIMIT 1").fetchone()
                self.relay.advance(db, row)
            self.start_relay().accept(private_text(self.event(2), "fixture"))
            self.assertEqual(3, db.execute("SELECT count(*) FROM deliveries WHERE state='done'").fetchone()[0])
            self.assertEqual(3, db.execute("SELECT count(*) FROM deliveries").fetchone()[0])
        self.assertEqual([(f"om_{i}", f"私聊 {i}") for i in (1, 2, 3)],
                         [call.args[:2] for call in self.reply.call_args_list])

    def test_worker_consumes_durable_queue(self):
        for i in (1, 2, 3):
            self.relay.accept(private_text(self.event(i), "fixture"))
        worker = threading.Thread(target=self.relay.work)
        worker.start()
        try:
            deadline = time.monotonic() + 4
            with closing(self.relay.connect()) as db:
                while time.monotonic() < deadline:
                    count = db.execute("SELECT count(*) FROM deliveries WHERE state='done'").fetchone()[0]
                    if count == 3:
                        break
                    time.sleep(0.02)
                self.assertEqual(3, count)
        finally:
            self.relay.stop.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())

    def test_uncertain_reply_reuses_uuid_and_expires(self):
        self.relay.accept(private_text(self.event(1), "fixture"))
        self.reply.side_effect = [ConnectionError(), None]
        with closing(self.relay.connect()) as db:
            def advance():
                self.start_relay().advance(db, db.execute("SELECT * FROM deliveries").fetchone())
            advance()
            advance()
            with self.assertRaises(ConnectionError):
                advance()
            db.execute("UPDATE deliveries SET first_reply_at=first_reply_at-1000")
            with self.assertRaises(RelayError):
                advance()
            self.reply.assert_called_once()
            db.execute("UPDATE deliveries SET first_reply_at=first_reply_at+1000")
            advance()
            self.assertEqual(*self.reply.call_args_list)

    def test_prepare_ask_only_recovers_unaccepted_permission_refusals(self):
        for number in range(1, 8):
            self.relay.accept(private_text(self.event(number), "fixture"))
        with closing(self.relay.connect()) as db:
            db.execute("UPDATE deliveries SET state='review',reason='harness HTTP 409 guarded_permissions'")
            db.execute("UPDATE deliveries SET first_reply_at=1 WHERE seq=3")
            db.execute("UPDATE deliveries SET source='accepted' WHERE seq=4")
            db.execute("UPDATE deliveries SET reason='other' WHERE seq=5")
            db.execute("UPDATE deliveries SET sender='ou_other' WHERE seq=6")
            db.execute("UPDATE deliveries SET binding='other' WHERE seq=7")
            original = list(db.execute("SELECT seq,send_id FROM deliveries ORDER BY seq"))
            self.harness.call = Mock(return_value={"bot": {"id": self.harness.bot},
                "task": {"threadId": "thread-1", "approvalMode": "full"}})
            with self.assertRaises(RelayError):
                self.relay.prepare_probed_thread("ou_fixture")
            self.assertEqual(0, db.execute("SELECT count(*) FROM deliveries WHERE state='queued'").fetchone()[0])
            self.harness.call.return_value["task"]["approvalMode"] = "ask"
            self.assertEqual(2, self.relay.prepare_probed_thread("ou_fixture"))
            self.harness.call.assert_called_with("/api/bots/fixture-bot/tasks/thread-1", {"approvalMode": "ask"}, method="PATCH")
            self.assertEqual(0, self.relay.prepare_probed_thread("ou_fixture"))
            self.assertEqual([1, 2], [r[0] for r in db.execute("SELECT seq FROM deliveries WHERE state='queued' ORDER BY seq")])
            self.assertEqual(original, list(db.execute("SELECT seq,send_id FROM deliveries ORDER BY seq")))

    def test_conversation_cannot_be_reassigned(self):
        self.routes = {"ou_someone_else": "thread-1"}
        with self.assertRaises(RelayError):
            self.start_relay()


if __name__ == "__main__":
    unittest.main()
