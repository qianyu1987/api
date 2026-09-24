"""HTTP boundary tests with a fake classifier; no model or production traffic."""
import http.client
import json
import threading
import unittest
from unittest.mock import Mock, patch

import server


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.agent = Mock()
        self.agent.predict.return_value = {"answers": {}}
        with patch.object(server.laya, "load", return_value=self.agent):
            self.httpd = server.LayaServer(("127.0.0.1", 0), "unused", "test-only", 1)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()

    def request(self, body, token="test-only"):
        connection = http.client.HTTPConnection(*self.httpd.server_address, timeout=3)
        try:
            connection.request("POST", "/v1/classify", json.dumps(body),
                               {"Authorization": "Bearer " + token})
            response = connection.getresponse()
            response.read()
            return response.status
        finally:
            connection.close()

    def test_auth_and_invalid_json_never_reach_classifier(self):
        self.assertEqual(self.request({"text": "hello"}, "wrong"), 401)
        for value in [[], None, "text", {}, {"text": ""}, {"text": "x" * 8001}]:
            self.assertEqual(self.request(value), 400)
        self.agent.predict.assert_not_called()

    def test_busy_is_rejected_and_slot_is_reusable(self):
        self.httpd.slots.acquire()
        self.assertEqual(self.request({"text": "hello"}), 503)
        self.httpd.slots.release()
        self.assertEqual(self.request({"text": "hello"}), 200)

    def test_failed_inference_releases_slot(self):
        self.agent.predict.side_effect = RuntimeError("private detail")
        self.assertEqual(self.request({"text": "hello"}), 500)
        self.agent.predict.side_effect = None
        self.assertEqual(self.request({"text": "hello"}), 200)

    def test_unsafe_startup_rejected_before_model_load(self):
        with patch.object(server.laya, "load") as load:
            for address, token, concurrency in [("0.0.0.0", "t", 1), ("127.0.0.1", "", 1),
                                                ("127.0.0.1", "t", 2)]:
                with self.assertRaises(ValueError):
                    server.LayaServer((address, 0), "unused", token, concurrency)
            load.assert_not_called()


if __name__ == "__main__":
    unittest.main()
