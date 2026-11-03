"""Local development fixture. Never run alongside the real Proclaim server.

Usage: python3 scripts/mock-proclaim.py /tmp/proclaim-tap-state.json
Edit that JSON file to change onAir, currentItem, localRevision, or quickScreenKind.
The fixture binds only to 127.0.0.1 and refuses occupied ports.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

state_file = Path(sys.argv[1])
session_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
items = [
    {"id": "fixture-connect", "title": "Connect · Test fixture", "kind": "Content", "slides": [{"index": 0}]},
    {"id": "fixture-parents", "title": "Parent’s Night Out · Test fixture", "kind": "Content", "slides": [{"index": 0}]},
]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        state = json.loads(state_file.read_text())
        path = urlparse(self.path).path
        if path == "/onair/session":
            if not state.get("onAir", True):
                self.respond(204, b"")
            else:
                self.respond(200, session_id.encode())
            return
        if self.headers.get("OnAirSessionId") != session_id:
            self.respond(404, b"Missing session header")
            return
        revision = state.get("localRevision", 1)
        if path == "/presentations/onair":
            self.respond(200, {
                "id": "integration-fixture", "localRevision": revision,
                "title": f"Connection test · Revision {revision}",
                "warmupStartIndex": 2, "serviceStartIndex": 2, "postServiceStartIndex": 2,
                "serviceItems": items,
            })
        elif path == "/onair/statusChanged":
            self.respond(200, {
                "presentationId": "integration-fixture", "presentationLocalRevision": revision,
                "status": {"revision": state.get("statusRevision", 1),
                           "itemId": items[state.get("currentItem", 0)]["id"], "slideIndex": 0,
                           "quickScreenKind": state.get("quickScreenKind", "None")},
            })
        else:
            self.respond(404, b"Unknown route")

    def respond(self, code, body):
        if isinstance(body, dict):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


print("Mock Proclaim on 127.0.0.1:52195 (test fixture only)", flush=True)
HTTPServer(("127.0.0.1", 52195), Handler).serve_forever()
