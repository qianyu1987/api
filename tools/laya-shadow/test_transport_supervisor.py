#!/usr/bin/env python3
"""Unit tests for transport_supervisor command builders and Unix-socket verification."""

from __future__ import annotations

import ast
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn, UnixStreamServer

sys.path.insert(0, str(Path(__file__).resolve().parent))
import transport_supervisor as supervisor


class FakeUnixServer:
    """Mimics server.py healthz/classify over a Unix socket without MLX."""

    def __init__(self, socket_path: str, token: str):
        self.path = socket_path
        self.token = token
        self.server = None

    def handler_class(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.0'

            def log_message(self, *args):
                pass

            def _send(self, status, payload):
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == '/healthz':
                    self._send(200, {'ok': True, 'mode': 'shadow'})
                else:
                    self._send(404, {'error': 'not_found'})

            def do_POST(self):
                length = int(self.headers.get('content-length', '0'))
                self.rfile.read(length) if length else None
                if self.headers.get('authorization') != f'Bearer {outer.token}':
                    self._send(401, {'error': 'unauthorized'})
                    return
                self._send(200, {'mode': 'shadow', 'answers': {'task_type': {'choice': 'coding'}}})

        return Handler

    def start(self):
        class ThreadingUnixServer(ThreadingMixIn, UnixStreamServer):
            daemon_threads = True
        self.server = ThreadingUnixServer(self.path, self.handler_class())
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()


def unix_http_request(socket_path: str, method: str, path: str, token: str | None = None,
                     body: bytes | None = None):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(5)
    sock.connect(socket_path)
    if body is not None:
        head = (f'{method} {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n'
                f'Content-Type: application/json\r\nContent-Length: {len(body)}\r\n')
        if token:
            head += f'Authorization: Bearer {token}\r\n'
        sock.sendall((head + '\r\n').encode() + body)
    else:
        sock.sendall(f'{method} {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n'.encode())
    data = b''
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
    sock.close()
    head, _, body_bytes = data.partition(b'\r\n\r\n')
    return int(head.split(b' ')[1]), body_bytes


class TransportSupervisorTests(unittest.TestCase):
    def test_ssh_base_keeps_strict_checking_and_pinned_identity(self):
        args = supervisor.build_ssh_base()
        self.assertIn(supervisor.IDENTITY, args)
        self.assertIn('BatchMode=yes', args)
        self.assertIn('StrictHostKeyChecking=yes', args)

    def test_tunnel_args_forward_loopback_tcp_only(self):
        args = supervisor.build_tunnel_args('/tmp/ctl')
        self.assertIn(f'127.0.0.1:{supervisor.REMOTE_TCP_PORT}:127.0.0.1:{supervisor.LOCAL_PORT}', args)
        self.assertIn('ExitOnForwardFailure=yes', args)
        self.assertNotIn(supervisor.REMOTE_SOCKET, args)

    def test_bridge_command_restarts_stateless_host_bridge(self):
        command = supervisor.remote_bridge_command()
        self.assertIn('laya_shadow_bridg[e].py', command)
        self.assertIn('/opt/relay-station/tools/laya-shadow/laya_shadow_bridge.py', command)
        self.assertIn('bridge_up', command)

    def test_host_commands_use_restricted_directory_and_container_gid(self):
        self.assertIn('0750', supervisor.remote_dir_bootstrap_command())
        self.assertIn(f'-g {supervisor.SOCKET_GROUP_GID}', supervisor.remote_dir_bootstrap_command())
        self.assertIn(f'chgrp {supervisor.SOCKET_GROUP_GID}', supervisor.remote_socket_repair_command())

    def test_verify_script_never_prints_the_token(self):
        script = supervisor.remote_verify_script()
        tree = ast.parse(script)
        printed = [node for node in ast.walk(tree)
                   if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                   and node.func.id == 'print']
        self.assertTrue(printed)
        self.assertFalse(any('token' in ast.dump(call) for call in printed))
        self.assertIn('config = json.load(sys.stdin)', script)

    def test_unix_http_verification_round_trip(self):
        token = 'test-verification-token-123456'
        with tempfile.TemporaryDirectory() as directory:
            socket_path = os.path.join(directory, 'c.sock')
            fake = FakeUnixServer(socket_path, token)
            fake.start()
            try:
                health, _ = unix_http_request(socket_path, 'GET', '/healthz')
                self.assertEqual(health, 200)
                bad, _ = unix_http_request(socket_path, 'POST', '/v1/classify',
                                           body=b'{"text": "x"}')
                self.assertEqual(bad, 401)
                good, payload = unix_http_request(socket_path, 'POST', '/v1/classify',
                                                  token=token, body=b'{"text": "x"}')
                self.assertEqual(good, 200)
                self.assertEqual(json.loads(payload)['answers']['task_type']['choice'], 'coding')
            finally:
                fake.stop()


if __name__ == '__main__':
    unittest.main(verbosity=2)
