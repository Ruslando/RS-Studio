"""Open the source installer against locally served, signed test-release assets."""
from __future__ import annotations
import argparse
import functools
import http.server
import json
import subprocess
import sys
import threading
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path, default=ROOT / "dist/bootstrap-test-release")
    parser.add_argument("--install-root", type=Path, default=ROOT / "build/bootstrap-preview-install")
    args = parser.parse_args()
    config_path = args.release.resolve() / "bootstrap-release.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    url = urllib.parse.urlsplit(config["manifest_url"])
    if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or url.path != "/bootstrap-manifest.json":
        parser.error("Use a signed --allow-local test release with base URL http://127.0.0.1:<port>")
    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    handler = functools.partial(QuietHandler, directory=str(args.release.resolve()))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", url.port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        result = subprocess.run([sys.executable, str(ROOT / "bootstrap/launcher.py"), "--config", str(config_path),
                                 "--install-root", str(args.install_root.resolve()), "--allow-local"], cwd=ROOT)
    finally:
        server.shutdown()
        server.server_close()
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
