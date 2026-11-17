# Tiny local SSE server for the probe: sends 3 events, 700ms apart.
import http.server, time, sys, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/json"):
            body = json.dumps({"ok": True}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream"); self.send_header("Cache-Control", "no-cache"); self.end_headers()
        for i in range(3):
            self.wfile.write(f"event: state\ndata: {{\"n\": {i}}}\n\n".encode()); self.wfile.flush(); time.sleep(0.7)
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
