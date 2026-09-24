#!/usr/bin/env python3
"""Persistent private Laya shadow transport: host Unix socket to Mac loopback.

Keeps the local Laya classifier reachable from the production host through one
SSH-forwarded Unix socket inside a dedicated restricted host directory, which
the API containers mount read-only. The supervisor owns:

* the local classifier subprocess (server.py bound to 127.0.0.1:19091),
* a host-side stdlib bridge (laya_shadow_bridge.py) that listens on the
  restricted host Unix socket and pipes to a loopback-only TCP port,
* a single SSH master that forward-binds that loopback TCP port to the Mac
  classifier,
* socket permission repair and host-side synthetic verification on every
  reconnect.

OpenSSH 7.4 on the host cannot -R bind a Unix socket directly; the bridge
keeps the socket inside the restricted host directory while the container-side
mount and Undici dispatcher stay unchanged. No TCP listener is exposed on the
Docker bridge.

While the relay switch stays off no website prompts are transmitted; host-side
verification only ever sends fixed synthetic text through the private socket.
Relay shadow failures never affect user requests.
"""
from __future__ import annotations

import json
import os
import secrets
import shlex
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
REMOTE_TCP_PORT = 19093  # host loopback only; piped by the bridge
REMOTE_DIR = '/opt/laya-shadow'
REMOTE_SOCKET = f'{REMOTE_DIR}/classifier.sock'
SOCKET_GROUP_GID = 1000
SYNTHETIC_TEXT = 'Write a Python function that adds two integers.'
RECONNECT_DELAY_S = 5

_STOP = False
classifier = None
owned_classifier = False


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
                               '-R', f'127.0.0.1:{REMOTE_TCP_PORT}:127.0.0.1:{LOCAL_PORT}', HOST]


def remote_bridge_kill_command() -> str:
    # Standalone invocation: the invoking shell's command line must not contain
    # the plain script name, hence the bracket trick.
    return "pkill -f 'laya_shadow_bridg[e].py' 2>/dev/null; true"


def remote_bridge_start_command() -> str:
    return ('rm -f ' + REMOTE_SOCKET
            + '; nohup python3 /opt/relay-station/tools/laya-shadow/laya_shadow_bridge.py '
            + '>> /opt/laya-shadow/bridge.log 2>&1 & sleep 2; '
            + 'test -S ' + REMOTE_SOCKET + ' && echo bridge_up || echo bridge_down')


def remote_dir_bootstrap_command() -> str:
    # Idempotent restricted directory; numeric gid matches the container node user.
    return f'install -d -m 0750 -o root -g {SOCKET_GROUP_GID} {REMOTE_DIR}'




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
        head += 'Connection: close\r\n\r\n'
    else:
        head = 'GET %s HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n' % path
    s.sendall(head.encode() + (body or b''))
    data = b''
    while True:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    head, _, body_bytes = data.partition(b'\r\n\r\n')
    if not head:
        raise RuntimeError('empty bridge response')
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


def run_remote(command: str, timeout: int = 20, stdin_payload: dict | None = None,
               merge_stderr: bool = False) -> tuple[int, str, str]:
    proc = subprocess.run(build_ssh_base() + [HOST, command], input=json.dumps(stdin_payload or {}),
                          text=True, capture_output=True, timeout=timeout)
    combined = proc.stdout if not merge_stderr else (proc.stdout + proc.stderr).strip()
    return proc.returncode, combined.strip(), proc.stderr.strip()


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


def ensure_host_bridge() -> None:
    run_remote(remote_bridge_kill_command(), timeout=15)
    code, output, stderr = run_remote(remote_bridge_start_command(), timeout=30)
    if code != 0 or not output.endswith('bridge_up'):
        raise RuntimeError(f'host bridge not up: {output[:100]} {stderr[:150]}')


def open_tunnel(control: str) -> subprocess.Popen:
    return subprocess.Popen(build_tunnel_args(control), stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)


def wait_socket_repairable(token: str) -> dict:
    deadline = time.monotonic() + 15
    last_error = 'no attempt'
    while time.monotonic() < deadline:
        code, output, stderr = run_remote(f'{remote_socket_repair_command()} && '
                                          f'python3 -c {shlex.quote(remote_verify_script())}',
                                          stdin_payload={'token': token}, timeout=25)
        if code == 0:
            return json.loads(output.splitlines()[-1])
        last_error = (stderr or output)[:200]
        time.sleep(1)
    raise RuntimeError(f'transport verification failed: {last_error}')


def restart_classifier() -> None:
    global classifier, owned_classifier
    if owned_classifier and classifier is not None and classifier.poll() is None:
        classifier.terminate()
        classifier.wait(timeout=10)
        classifier = None
    if local_classifier_healthy():
        classifier = None
        owned_classifier = False
        log('reusing_existing_classifier')
    else:
        classifier = start_classifier()
        owned_classifier = True
        log('classifier_started')


def main() -> int:
    global _STOP, classifier, owned_classifier
    signal.signal(signal.SIGTERM, lambda *_: globals().update(_STOP=True))
    signal.signal(signal.SIGINT, lambda *_: globals().update(_STOP=True))
    ensure_token()
    control = str(RUNTIME / 'ssh-control')
    restart_classifier()
    attempts = 0
    while not _STOP:
        tunnel = None
        try:
            code, _, stderr = run_remote(remote_dir_bootstrap_command())
            if code != 0:
                raise RuntimeError(f'host directory bootstrap failed: {stderr[:200]}')
            ensure_host_bridge()
            tunnel = open_tunnel(control)
            report = wait_socket_repairable(TOKEN_FILE.read_text())
            log('transport_ready', **report, attempt=attempts + 1)
            attempts = 0
            next_classifier_check = time.monotonic()
            while not _STOP and tunnel.poll() is None:
                if time.monotonic() >= next_classifier_check:
                    next_classifier_check = time.monotonic() + 5
                    if not local_classifier_healthy():
                        restart_classifier()
                        raise RuntimeError('classifier unavailable; restarting transport cycle')
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
