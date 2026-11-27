"""Local test server: serves the app and a tiny in-memory imitation of the Supabase API
used by js/remote-fake.js. Run from the project folder:  python3 scripts/fake_server.py 8766
then open http://localhost:8766/?fake  (two browsers = two devices)."""
import json, sys, threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

rows = {"places": {}, "photos": {}}
files = {}
lock = threading.Lock()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


class H(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query, keep_blank_values=True).items()}
        if u.path == "/fake/pull":
            with lock:
                out = [r for r in rows[q["table"]].values()
                       if r["user_id"] == q["user"] and (not q["since"] or r["server_at"] > q["since"])]
            return self.send_json(sorted(out, key=lambda r: r["server_at"]))
        if u.path == "/fake/file":
            data = files.get(q["path"])
            if data is None:
                return self.send_json({"error": "not found"}, 404)
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/fake/upsert":
            with lock:
                for r in json.loads(self.body()):
                    r["server_at"] = now()
                    rows[q["table"]][r["id"]] = r
            return self.send_json({"ok": True})
        if u.path == "/fake/remove":
            for p in json.loads(self.body()):
                files.pop(p, None)
            return self.send_json({"ok": True})
        self.send_json({"error": "?"}, 404)

    def do_PUT(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/fake/file":
            files[q["path"]] = self.body()
            return self.send_json({"ok": True})
        self.send_json({"error": "?"}, 404)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    ThreadingHTTPServer(("", port), H).serve_forever()
