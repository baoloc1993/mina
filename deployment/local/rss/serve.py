"""Máy chủ feed GIẢ cho dogfood Đọc báo (vòng 6): thử lỗi / định dạng mà không phụ thuộc mạng ngoài.

  python deployment/local/rss/serve.py [cổng=8787]

Emulator Android tới được máy dev qua 10.0.2.2:<cổng>; mock SDK trên trình duyệt dùng 127.0.0.1:<cổng>.
Đường dẫn:
  /ok.xml            RSS 2.0 hợp lệ, 8 bài (đổi tiêu đề bài số 1 mỗi lần gọi /bump.xml để thử "tiêu đề đổi")
  /atom.xml          Atom 1.0 hợp lệ, 5 bài
  /loi.html          trang HTML — không phải feed (INVALID_REQUEST)
  /404               trả 404
  /503               trả 503
  /redirect-http     301 cùng host (ok.xml)
  /redirect-other    302 sang host khác (other-host.invalid) — bị chặn ở bước chuyển hướng (NET_BLOCKED)
  /big.xml           > 5 MB (NET_ERROR)
  /slow.xml          chậm 20 giây (hết giờ 15 giây)
  /fail-sometimes.xml  hỏng mỗi lần gọi thứ hai (503), còn lại trả ok
"""
import http.server
import socketserver
import sys
import time
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
calls = {"n": 0, "bump": 0}


def rss(title: str, n: int, first_title: str | None = None) -> bytes:
    now = datetime.now(timezone.utc)
    items = []
    for i in range(n):
        t = first_title if (i == 0 and first_title) else f"Bài thử số {i + 1}: tin từ máy chủ giả"
        items.append(
            f"<item><title>{t}</title><link>http://10.0.2.2:{PORT}/bai/{i + 1}</link><guid>local-{i + 1}</guid>"
            f"<pubDate>{format_datetime(now - timedelta(hours=i * 3))}</pubDate>"
            f"<description><![CDATA[<p>Tóm tắt <b>bài {i + 1}</b> của feed giả.</p>]]></description></item>"
        )
    return f'<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>{title}</title>{"".join(items)}</channel></rss>'.encode()


def atom() -> bytes:
    now = datetime.now(timezone.utc)
    entries = "".join(
        f'<entry><title>Bài Atom {i + 1}</title><id>atom-{i + 1}</id><link rel="alternate" href="http://10.0.2.2:{PORT}/atom/{i + 1}"/>'
        f"<updated>{(now - timedelta(hours=i * 5)).isoformat()}</updated><summary>Tóm tắt Atom {i + 1}</summary></entry>"
        for i in range(5)
    )
    return f'<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Blog Atom giả</title>{entries}</feed>'.encode()


class H(http.server.BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str = "application/xml; charset=utf-8", headers: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/ok.xml":
            return self._send(200, rss("Blog thử (máy chủ giả)", 8))
        if p == "/bump.xml":
            calls["bump"] += 1
            return self._send(200, rss("Blog thử (máy chủ giả)", 8, f"Tiêu đề đã đổi lần {calls['bump']}"))
        if p == "/atom.xml":
            return self._send(200, atom())
        if p == "/loi.html":
            return self._send(200, "<!doctype html><html><body><h1>Trang chủ, không phải feed</h1></body></html>".encode(), "text/html; charset=utf-8")
        if p == "/404":
            return self._send(404, b"khong co", "text/plain")
        if p == "/503":
            return self._send(503, b"loi may chu", "text/plain")
        if p == "/redirect-http":
            return self._send(301, b"", headers={"Location": f"http://10.0.2.2:{PORT}/ok.xml"})
        if p == "/redirect-other":
            return self._send(302, b"", headers={"Location": f"http://other-host.invalid:{PORT}/ok.xml"})
        if p == "/big.xml":
            return self._send(200, b"<rss><channel>" + b"x" * (6 * 1024 * 1024) + b"</channel></rss>")
        if p == "/slow.xml":
            time.sleep(20)
            return self._send(200, rss("Chậm", 3))
        if p == "/fail-sometimes.xml":
            calls["n"] += 1
            return self._send(503, b"loi", "text/plain") if calls["n"] % 2 == 0 else self._send(200, rss("Lúc được lúc không", 4))
        if p.startswith(("/bai/", "/atom/")):
            return self._send(200, f"<html><body><h1>Bài {p}</h1><p>Trang bài viết giả.</p></body></html>".encode(), "text/html; charset=utf-8")
        return self._send(404, b"khong co", "text/plain")

    def log_message(self, fmt, *a):
        sys.stderr.write("[rss] " + (fmt % a) + "\n")


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    print(f"feed giả tại http://0.0.0.0:{PORT}/ (emulator: http://10.0.2.2:{PORT}/ok.xml)", flush=True)
    S(("0.0.0.0", PORT), H).serve_forever()
