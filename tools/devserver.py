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
        # Dev-only screenshot sink: POST /shot?name=foo. Hero-capture requests
        # also carry ?run=<id>; the fixed authority file owns an atomic lock,
        # while every image is run-scoped and accepted only from that owner.
        import json
        import os
        import re
        import tempfile
        from urllib.parse import urlparse, parse_qs

        def reject(status, message):
            payload = message.encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def atomic_replace(target, payload, prefix):
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(
                        mode='wb', dir=os.path.dirname(target), prefix=prefix, delete=False) as f:
                    temporary = f.name
                    f.write(payload)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(temporary, target)
                return True
            except OSError:
                if temporary:
                    try:
                        os.unlink(temporary)
                    except OSError:
                        pass
                return False

        u = urlparse(self.path)
        if u.path != '/shot':
            reject(404, 'not found')
            return
        query = parse_qs(u.query)
        name = query.get('name', ['shot'])[0]
        name = re.sub(r'[^a-zA-Z0-9_-]', '', name)[:60] or 'shot'
        raw_run_id = query.get('run', [''])[0]
        run_id = re.sub(r'[^a-zA-Z0-9_-]', '', raw_run_id)[:60]
        if raw_run_id and (not run_id or run_id != raw_run_id):
            reject(400, 'invalid hero run id')
            return
        length = int(self.headers.get('Content-Length', 0))
        if length > 30_000_000:
            reject(413, 'payload too large')
            return
        body = self.rfile.read(length)
        outdir = os.path.join(ROOT, 'tools', 'shots')
        os.makedirs(outdir, exist_ok=True)
        lockdir = os.path.join(outdir, '.hero-capture.lock')
        owner_path = os.path.join(lockdir, 'owner.json')

        def current_owner():
            try:
                with open(owner_path, encoding='utf-8') as f:
                    return json.load(f).get('runId')
            except (OSError, ValueError, TypeError):
                return None

        def release_owner():
            try:
                os.unlink(owner_path)
                os.rmdir(lockdir)
                return True
            except OSError:
                return False

        is_authority = name == 'r4-hero-contracts'
        is_scoped_hero = name.startswith('hero-') and '-r4-hero-' in name
        terminal_authority = False
        if is_authority or is_scoped_hero or run_id:
            if not run_id:
                reject(400, 'hero evidence requires a run id')
                return
            if is_authority:
                try:
                    marker = json.loads(body)
                except (ValueError, TypeError):
                    reject(400, 'hero authority must be JSON')
                    return
                if marker.get('runId') != run_id:
                    reject(400, 'hero authority run id mismatch')
                    return
                status = marker.get('status')
                if status == 'running':
                    try:
                        os.mkdir(lockdir)
                        with open(owner_path, 'x', encoding='utf-8') as f:
                            json.dump({'runId': run_id, 'status': 'running'}, f)
                            f.write('\n')
                    except FileExistsError:
                        reject(409, f'hero evidence is already owned by {current_owner() or "unknown run"}')
                        return
                    except OSError:
                        try:
                            os.rmdir(lockdir)
                        except OSError:
                            pass
                        reject(500, 'unable to acquire hero evidence ownership')
                        return
                elif status in ('passed', 'failed'):
                    if current_owner() != run_id:
                        reject(409, 'hero evidence ownership changed')
                        return
                    terminal_authority = True
                else:
                    reject(400, 'hero authority status must be running, passed, or failed')
                    return
            else:
                if current_owner() != run_id:
                    reject(409, 'hero evidence ownership changed')
                    return
                if not name.startswith(run_id + '-'):
                    reject(400, 'hero artifact is not scoped to its run id')
                    return

        target = os.path.join(outdir, name + '.png')
        forced_write_failure = (
            os.environ.get('APEX_EVIDENCE_FAULT_PROBES') == '1'
            and self.headers.get('X-Apex-Evidence-Probe') == 'fail-write'
        )
        if forced_write_failure or not atomic_replace(target, body, f'.{name}.'):
            # Once a hero run owns the authority, never roll back to an older
            # unlocked pass marker. Retaining the lock makes the stale bytes
            # explicitly non-authoritative and lets the same run publish a
            # terminal failed marker when storage recovers.
            reject(500, 'unable to persist evidence')
            return
        if terminal_authority and not release_owner():
            reject(500, 'evidence persisted but ownership release failed')
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *args):
        pass


handler = functools.partial(NoCacheHandler, directory=ROOT)
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler).serve_forever()
