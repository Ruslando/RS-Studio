"""Browser diagnostics reach the existing terminal logger through a local route."""
import unittest

from fastapi.testclient import TestClient

from rs_studio import server


class FrontendErrorTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app, base_url="http://127.0.0.1:8000")
        self.payload = {"phase": "startup", "kind": "exception",
                        "message": "TypeError: notes is not iterable\n    at preview (fretboard.js:1:2)"}

    def test_logs_original_stack_at_error_level(self):
        with self.assertLogs("uvicorn.error", level="ERROR") as logged:
            response = self.client.post("/api/frontend-error", json=self.payload)
        self.assertEqual(response.status_code, 204)
        self.assertIn("[frontend:startup:exception] " + self.payload["message"], logged.output[0])

    def test_strips_terminal_control_sequences(self):
        self.payload["message"] = "failure\x1b[2J\r\n    at example"
        with self.assertLogs("uvicorn.error", level="ERROR") as logged:
            self.client.post("/api/frontend-error", json=self.payload)
        self.assertNotIn("\x1b", logged.output[0])
        self.assertNotIn("\r", logged.output[0])
        self.assertIn("\n    at example", logged.output[0])

    def test_rejects_invalid_reports(self):
        for change in ({"phase": "unknown"}, {"kind": "unknown"}, {"message": "x" * 16001}, {"message": ""}):
            with self.subTest(change=list(change)):
                self.assertEqual(self.client.post("/api/frontend-error", json={**self.payload, **change}).status_code, 422)

    def test_foreign_websites_cannot_write_terminal_logs(self):
        response = self.client.post("/api/frontend-error", json=self.payload,
                                    headers={"Origin": "https://example.com"})
        self.assertEqual(response.status_code, 403)
