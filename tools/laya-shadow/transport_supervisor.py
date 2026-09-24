#!/usr/bin/env python3
"""Persistent private Laya shadow transport: host Unix socket to Mac loopback.

Keeps the local Laya classifier reachable from the production host through one
SSH-forwarded Unix socket inside a dedicated restricted host directory, which
the API containers mount read-only. The supervisor owns:

* the local classifier subprocess (server.py bound to 127.0.0.1:19091),
* a single SSH master with the -R socket forward,
* socket permission repair and host-side synthetic verification on every
  reconnect.

While the relay switch stays off no website prompts are transmitted; host-side
verification only ever sends fixed synthetic text through the private socket.
Relay shadow failures never affect user requests.
"""
from __future__ import annotations

import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

RUNTIME = Path(os.environ.get('LAYA_RUNTIME', '/Volumes/brainos/CodexMedia/generated/laya-mlx-shadow'))
REPO_TOOLS = Path(__file__).resolve().parent
MODEL_PATH = RUNTIME / 'models' / 'laya-multilingual-mlx'
TOKEN_FILE = RUNTIME / 'transport-token'
LOG_FILE = RUNTIME / 'transport.log'
VENV_PYTHON = RUNTIME / '.venv' / 'bin' / 'python'

HOST = 'root@101.35.223.148'
IDENTITY = '/Volumes/brainos/MacStorage/Downloads/111.pem'
LOCAL_PORT = 19091
REMOTE_DIR = '/opt/laya-shadow'
REMOTE_SOCKET = f'{REMOTE_DIR}/classifier.sock'
SOCKET_GROUP_GID = 1000
SYNTHETIC_TEXT = 'Write a Python function that adds two integers.'
RECONNECT_DELAY_S = 5

_STOP = False


def log(event: str, **fields: object) -> None:
    record = {'ts': time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime()), 'event': event, **fields}
    line = json.dumps(record, ensure_ascii=False)
    try:
        with LOG_FILE.open('a') as handle:
            handle.write(line + '\n')
    except OSError:
        pass
    print(line, flush=True)


def build_ssh_base() -> list[str]:
    return ['ssh', '-i', IDENTITY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'ServerAliveInterval=10',
            '-o', 'ServerAliveCountMax=2']


def build_tunnel_args(control: str) -> list[str]:
    return build_ssh_base() + ['-S', control, '-M', '-NT', '-o', 'ExitOnForwardFailure=yes',
                               '-R', f'{REMOTE_SOCKET}:127.0.0.1:{LOCAL_PORT}', HOST]


def remote_dir_bootstrap_command() -> str:
    # Idempotent restricted directory; numeric gid matches the container node user.
    return f'install -d -m 0750 -o root -g {SOCKET_GROUP_GID} {REMOTE_DIR}'


def remote_socket_reset_command() -> str:
    return f'rm -f {REMOTE_SOCKET}'


def remote_socket_repair_command() -> str:
    # sshd creates the listener root-owned; give the container node user connect access.
    return f'chgrp {SOCKET_GROUP_GID} {REMOTE_SOCKET} && chmod g+w {REMOTE_SOCKET}'


def remote_verify_script() -> str:
    return r'''
import json, socket, sys
config = json.load(sys.stdin)
def request(path, token=None, body=None):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(6)
    s.connect('/opt/laya-shadow/classifier.sock')
    if body is not None:
        head = ('POST %s HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n'
                'Content-Length: %d\r\n') % (path, len(body))
        if token:
            head += 'Authorization: Bearer %s\r\n' % token
        head += 'Connection: close\r\n\r\n' + body
    else:
        head = 'GET %s HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n' % path
    s.sendall(head.encode())
    data = b''
    while True:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    head, _, body_bytes = data.partition(b'\r\n\r\n')
    status = int(head.split(b' ')[1])
    return status, body_bytes
health, _ = request('/healthz')
unauthorized, _ = request('/v1/classify', body='{"text": "synthetic probe"}'.encode())
authorized, payload = request('/v1/classify', token=config['token'],
                              body=json.dumps({'text': 'Write a Python function that adds two integers.'}).encode())
result = json.loads(payload)
report = {'health': health, 'unauthorized': unauthorized, 'authorized': authorized,
          'mode': result.get('mode')}
print(json.dumps(report))
if not (health == 200 and unauthorized == 401 and authorized == 200 and result.get('mode') == 'shadow'):
    sys.exit(1)
'''


def run_remote(command: str, timeout: int = 20, stdin_payload: dict | None = None) -> tuple[int, str]:
    proc = subprocess.run(build_ssh_base() + [HOST, command], input=json.dumps(stdin_payload or {}),
                          text=True, capture_output=True, timeout=timeout)
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def local_classifier_healthy() -> bool:
    try:
        s = socket.create_connection(('127.0.0.1', LOCAL_PORT), timeout=2)
        s.sendall(b'GET /healthz HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n')
        s.settimeout(2)
        received = s.recv(64)
        s.close()
        return received.startswith(b'HTTP/1.0 200')
    except OSError:
        return False


def start_classifier() -> subprocess.Popen:
    environment = dict(os.environ)
    environment['LAYA_SHADOW_TOKEN'] = TOKEN_FILE.read_text()
    proc = subprocess.Popen(
        [str(VENV_PYTHON), '-u', str(REPO_TOOLS / 'server.py'), '--model', str(MODEL_PATH),
         '--port', str(LOCAL_PORT)],
        env=environment, cwd=str(REPO_TOOLS), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    assert proc.stdout is not None
    for line in iter(proc.stdout.readline, ''):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if payload.get('ready') is True:
            return proc
        if proc.poll() is not None:
            raise RuntimeError('classifier exited during startup')
    raise RuntimeError('classifier startup stalled')


def ensure_token() -> None:
    if not TOKEN_FILE.exists():
        TOKEN_FILE.write_text(secrets.token_urlsafe(32))
        TOKEN_FILE.chmod(0o600)


def open_tunnel(control: str) -> subprocess.Popen:
    code, output = run_remote(remote_socket_reset_command())
    if code != 0:
        raise RuntimeError(f'socket reset failed: {output[:200]}')
    return subprocess.Popen(build_tunnel_args(control), stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)


def wait_socket_repairable(token: str) -> dict:
    deadline = time.monotonic() + 15
    last_error = 'no attempt'
    while time.monotonic() < deadline:
        code, output = run_remote(f'{remote_socket_repair_command()} && '
                                  f'python3 -c {json.dumps(remote_verify_script())}',
                                  stdin_payload={'token': token}, timeout=25)
        if code == 0:
            return json.loads(output.splitlines()[-1])
        last_error = output[:200]
        time.sleep(1)
    raise RuntimeError(f'transport verification failed: {last_error}')


def main() -> int:
    global _STOP
    signal.signal(signal.SIGTERM, lambda *_: globals().update(_STOP=True))
    signal.signal(signal.SIGINT, lambda *_: globals().update(_STOP=True))
    ensure_token()
    classifier = None
    owned_classifier = False
    control = str(RUNTIME / 'ssh-control')
    if local_classifier_healthy():
        classifier = None
        log('reusing_existing_classifier')
    else:
        classifier = start_classifier()
        owned_classifier = True
        log('classifier_started')
    attempts = 0
    while not _STOP:
        tunnel = None
        try:
            code, output = run_remote(remote_dir_bootstrap_command())
            if code != 0:
                raise RuntimeError(f'host directory bootstrap failed: {output[:200]}')
            tunnel = open_tunnel(control)
            report = wait_socket_repairable(TOKEN_FILE.read_text())
            log('transport_ready', **report, attempt=attempts + 1)
            attempts = 0
            while not _STOP and tunnel.poll() is None:
                if owned_classifier and classifier is not None and classifier.poll() is not None:
                    raise RuntimeError(f'classifier exited code {classifier.poll()}')
                time.sleep(1)
            if _STOP:
                break
            raise RuntimeError(f'ssh master exited code {tunnel.poll()}')
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            attempts += 1
            log('transport_error', error=str(error)[:300], attempt=attempts)
        finally:
            subprocess.run(build_ssh_base() + ['-S', control, '-O', 'exit', HOST],
                           capture_output=True, timeout=15)
            tunnel.kill() if tunnel else None
        if _STOP:
            break
        time.sleep(RECONNECT_DELAY_S)
    subprocess.run(build_ssh_base() + ['-S', control, '-O', 'exit', HOST], capture_output=True, timeout=15)
    if owned_classifier and classifier is not None:
        classifier.terminate()
        classifier.wait(timeout=10)
        log('classifier_stopped')
    log('supervisor_exited')
    return 0


if __name__ == '__main__':
    sys.exit(main())
