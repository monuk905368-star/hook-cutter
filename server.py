#!/usr/bin/env python3
"""Hook Cutter ka local server: YouTube link se video laata hai aur page serve karta hai."""
import json, os, re, shutil, subprocess, sys, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(ROOT, "downloads")
os.makedirs(DL, exist_ok=True)
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/script.js": ("script.js", "application/javascript; charset=utf-8"),
}
YT = re.compile(r"^https?://((www|m|music)\.)?(youtube\.com|youtu\.be)/", re.I)
JOBS = {}


def explain(tail):
    t = "".join(tail)
    if "403" in t:
        return "YouTube ne download block kiya (403). Terminal me 'pip install -U yt-dlp' chalao aur dobara try karo."
    if "Private video" in t or "Sign in" in t:
        return "Ye video private ya login wali hai, download nahi ho sakti."
    if "ffmpeg" in t.lower() and "not found" in t.lower():
        return "ffmpeg install nahi hai. 'sudo apt install ffmpeg' chalao."
    return "Video download nahi ho payi. Link check karo aur dobara try karo."


def run_job(jid, url):
    job = JOBS[jid]
    tail = []
    base = [sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-warnings"]
    try:
        t = subprocess.run(base + ["--skip-download", "--print", "title", url],
                           capture_output=True, text=True, timeout=90)
        if t.returncode:
            tail.append(t.stderr)
            raise RuntimeError("title")
        lines = t.stdout.strip().splitlines()
        job["title"] = lines[0] if lines else "video"
        out = os.path.join(DL, jid + ".%(ext)s")
        p = subprocess.Popen(
            base + ["--newline", "-S", "res:720,vcodec:h264,acodec:aac", "-f", "bv*+ba/b",
                    "--merge-output-format", "mp4", "-o", out, url],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in p.stdout:
            m = re.search(r"\[download\]\s+(\d+(?:\.\d+)?)%", line)
            if m:
                job["pct"] = float(m.group(1))
            tail.append(line)
            tail[:] = tail[-40:]
        p.wait()
        if p.returncode or not os.path.exists(os.path.join(DL, jid + ".mp4")):
            raise RuntimeError("download")
        job.update(state="done", media="/media/" + jid + ".mp4")
    except Exception:
        job.update(state="error", error=explain(tail))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/ping":
            return self.send_json({"ok": True})
        if u.path == "/api/status":
            job = JOBS.get(parse_qs(u.query).get("id", [""])[0])
            return self.send_json(job, 200) if job else self.send_json({"error": "Job nahi mila."}, 404)
        if u.path.startswith("/media/"):
            return self.serve_media(u.path[len("/media/"):])
        if u.path in STATIC:
            name, ctype = STATIC[u.path]
            with open(os.path.join(ROOT, name), "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        self.send_error(404)

    def do_POST(self):
        if urlparse(self.path).path != "/api/fetch":
            return self.send_error(404)
        try:
            n = int(self.headers.get("Content-Length", "0"))
            url = json.loads(self.rfile.read(n) or b"{}").get("url", "").strip()
        except Exception:
            url = ""
        if not YT.match(url):
            return self.send_json({"error": "Ye YouTube ka link nahi lagta. youtube.com ya youtu.be wala link daalo."}, 400)
        jid = uuid.uuid4().hex[:12]
        JOBS[jid] = {"state": "running", "pct": None, "title": None}
        threading.Thread(target=run_job, args=(jid, url), daemon=True).start()
        self.send_json({"id": jid})

    def serve_media(self, name):
        path = os.path.join(DL, os.path.basename(name))
        if not re.fullmatch(r"[0-9a-f]{12}\.mp4", name) or not os.path.isfile(path):
            return self.send_error(404)
        size = os.path.getsize(path)
        start, end, code = 0, size - 1, 200
        rng = self.headers.get("Range")
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip()) if rng else None
        if m:
            a, b = m.groups()
            if a == "" and b != "":
                start = max(0, size - int(b))
            elif a != "":
                start = int(a)
                end = min(int(b), size - 1) if b else end
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            code = 206
        self.send_response(code)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        sys.exit("yt-dlp install nahi hai. Pehle chalao:  pip install -U 'yt-dlp[default]'")
    if not shutil.which("ffmpeg"):
        print("Dhyan: ffmpeg nahi mila. 'sudo apt install ffmpeg' chalao, warna video merge nahi hogi.")
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        sys.exit(f"Port {port} busy hai. Doosra port try karo:  python3 server.py 8001")
    print(f"Chal raha hai: http://localhost:{port}   (band karne ke liye Ctrl+C)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nBand.")


if __name__ == "__main__":
    main()
