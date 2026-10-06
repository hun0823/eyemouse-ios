#!/usr/bin/env python3
"""Local preview of the bundled wg12-ud page (not the iOS binary)."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "www"
PORT = 43127


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    print(f"아이마우스 wg12-ud preview  http://127.0.0.1:{PORT}/?v=wg12", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
