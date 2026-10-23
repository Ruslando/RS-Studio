"""Editor preferences survive a change of port: they live in a file, not only in the browser."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from rs_studio import server


class PrefsTest(unittest.TestCase):
    def test_round_trip_keeps_only_strings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(server, "_CONFIG_ROOT", root), patch.object(server, "_PREFS", root / "prefs.json"):
                client = TestClient(server.app, base_url="http://127.0.0.1:8000")
                self.assertEqual(client.get("/api/prefs").json(), {})
                saved = client.post("/api/prefs", json={"cw.theme": "light", "bad": 3})
                self.assertEqual(saved.json(), {"saved": 1})
                # Another port is another origin to the browser, not to the server.
                other = TestClient(server.app, base_url="http://127.0.0.1:41234")
                self.assertEqual(other.get("/api/prefs").json(), {"cw.theme": "light"})


if __name__ == "__main__":
    unittest.main()
