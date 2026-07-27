#!/usr/bin/env python3
"""Dev server: static files with Cache-Control: no-store (always fresh modules)."""
import http.server
import functools
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8341
ROOT = sys.argv[2] if len(sys.argv) > 2 else '.'


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_POST(self):
        # dev-only screenshot sink: POST /shot?name=foo with PNG body
        import os
        import re
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        if u.path != '/shot':
            self.send_response(404)
            self.end_headers()
            return
        name = parse_qs(u.query).get('name', ['shot'])[0]
        name = re.sub(r'[^a-zA-Z0-9_-]', '', name)[:60] or 'shot'
        length = int(self.headers.get('Content-Length', 0))
        if length > 30_000_000:
            self.send_response(413)
            self.end_headers()
            return
        body = self.rfile.read(length)
        outdir = os.path.join(ROOT, 'tools', 'shots')
        os.makedirs(outdir, exist_ok=True)
        with open(os.path.join(outdir, name + '.png'), 'wb') as f:
            f.write(body)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *args):
        pass


handler = functools.partial(NoCacheHandler, directory=ROOT)
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler).serve_forever()
