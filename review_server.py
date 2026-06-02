#!/usr/bin/env python3
"""
GBrain review proxy server
- GET  /proxy?path=<gbrain_path>       → 轉發到 Railway（自動加 OTP）
- POST /proxy-write?slug=<slug>        → put_page 寫回 GBrain
"""
import http.server, urllib.request, urllib.parse, json, os, hmac, hashlib, time, re

PORT = 7788
GBRAIN_BASE = "https://gbrain-production-18fa.up.railway.app"

def load_totp_secret():
    s = os.environ.get("GBRAIN_TOTP_SECRET", "")
    if s: return s
    env_file = os.path.expanduser("~/.gbrain/gateway.env")
    if os.path.exists(env_file):
        content = open(env_file).read()
        m = re.search(r"GBRAIN_TOTP_SECRET=([a-f0-9]+)", content)
        if m: return m.group(1)
    return ""

def gen_otp(secret):
    day = int(time.time() // 86400)
    return hmac.new(secret.encode(), str(day).encode(), hashlib.sha256).hexdigest()[:10]

SECRET = load_totp_secret()

def gbrain_get(path):
    otp = gen_otp(SECRET)
    sep = "&" if "?" in path else "?"
    url = GBRAIN_BASE + "/" + path.lstrip("/") + sep + "otp=" + otp
    req = urllib.request.Request(url, headers={"User-Agent": "gbrain-review/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.read()

def gbrain_put_page(slug, content):
    otp = gen_otp(SECRET)
    data = json.dumps({"slug": slug, "content": content}).encode()
    url = GBRAIN_BASE + "/write?action=put_page&otp=" + otp
    req = urllib.request.Request(url, data=data, headers={
        "User-Agent": "gbrain-review/1.0",
        "Content-Type": "application/json"
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.dirname(os.path.abspath(__file__)), **kw)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/proxy":
            self.handle_proxy(parsed.query)
        else:
            super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/proxy-write":
            self.handle_write(parsed.query)
        else:
            self.send_error(404)

    def handle_proxy(self, query):
        params = urllib.parse.parse_qs(query)
        path = params.get("path", [""])[0]
        if not path:
            self.send_error(400, "missing path"); return
        try:
            body = gbrain_get(path)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._json_error(str(e))

    def handle_write(self, query):
        params = urllib.parse.parse_qs(query)
        slug = params.get("slug", [""])[0]
        if not slug:
            self.send_error(400, "missing slug"); return
        length = int(self.headers.get("Content-Length", 0))
        content = self.rfile.read(length).decode("utf-8")
        try:
            body = gbrain_put_page(slug, content)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._json_error(str(e))

    def _json_error(self, msg):
        self.send_response(502)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps({"error": msg}).encode())

    def log_message(self, fmt, *args):
        pass

if __name__ == "__main__":
    if not SECRET:
        print("WARNING: GBRAIN_TOTP_SECRET not found")
    with http.server.HTTPServer(("", PORT), Handler) as s:
        print(f"GBrain review server: http://localhost:{PORT}/review.html")
        s.serve_forever()
