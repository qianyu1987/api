#!/usr/bin/env python3
"""Ephemeral host-to-Mac transport probe using only a synthetic prompt.

Does not deploy code, sample website requests, change SSH config, or restart APIs.
The remote port binds to loopback and is removed when the SSH master exits.
"""
import argparse
import json
import secrets
import shlex
import subprocess
import tempfile
import threading
from pathlib import Path

from server import LayaServer

REMOTE_PROBE = r'''
import json, sys, urllib.request, urllib.error
config = json.load(sys.stdin)
url = 'http://127.0.0.1:19092/v1/classify'
def call(token):
    request = urllib.request.Request(url, data=json.dumps({'text': 'Write a Python function that adds two integers.'}).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, {}
unauthorized, _ = call('invalid-probe-token')
status, result = call(config['token'])
print(json.dumps({'unauthorized_status': unauthorized, 'authorized_status': status,
    'mode': result.get('mode'), 'duration_ms': result.get('duration_ms'),
    'task_type': result.get('answers', {}).get('task_type', {}).get('choice')}))
if unauthorized != 401 or status != 200 or result.get('mode') != 'shadow':
    sys.exit(1)
'''

CONTAINER_PROBE = r'''
import json, subprocess, sys
results = []
for name in ['relay-station-api-1', 'relay-station-api-2']:
    networks = json.loads(subprocess.check_output(
        ['docker', 'inspect', name, '--format', '{{json .NetworkSettings.Networks}}'], timeout=5))
    gateway = networks['relay-station-backend']['Gateway']
    script = """
const addresses = JSON.parse(process.argv[1]);
for (const address of addresses) {
  try {
    const response = await fetch('http://' + address + ':19092/healthz', {signal: AbortSignal.timeout(1500)});
    await response.body?.cancel();
    console.log(JSON.stringify({address, reachable:true,status:response.status}));
  } catch (error) {
    console.log(JSON.stringify({address, reachable:false,code:error.cause?.code || error.name}));
  }
}
"""
    output = subprocess.check_output(['docker', 'exec', name, 'node', '--input-type=module',
        '-e', script, json.dumps(['127.0.0.1', gateway])], timeout=8, universal_newlines=True)
    results.append({'replica': name, 'checks': [json.loads(line) for line in output.splitlines()]})
print(json.dumps({'container_checks': results}))
if any(check['reachable'] for row in results for check in row['checks']):
    sys.exit(1)
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    args = parser.parse_args()
    token = secrets.token_urlsafe(32)
    server = LayaServer(('127.0.0.1', 0), args.model, token, 1)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    ssh = ['ssh', '-i', '/Volumes/brainos/MacStorage/Downloads/111.pem',
           '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes']
    target = 'root@101.35.223.148'
    try:
        with tempfile.TemporaryDirectory(prefix='laya-probe-') as directory:
            control = str(Path(directory) / 'ssh')
            master = ssh + ['-S', control, '-M', '-fNT', '-o', 'ExitOnForwardFailure=yes',
                            '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
                            '-R', f'127.0.0.1:19092:127.0.0.1:{server.server_port}', target]
            try:
                subprocess.run(master, check=True, timeout=20, capture_output=True)
                # Confirm effective binding, including server-side GatewayPorts policy.
                binding = subprocess.run(ssh + [target, 'ss -H -ltn sport = :19092'],
                                         check=True, timeout=15, capture_output=True, text=True)
                listeners = [line.split()[3] for line in binding.stdout.splitlines()]
                if listeners != ['127.0.0.1:19092']:
                    raise RuntimeError('remote listener is not exclusively IPv4 loopback')
                isolation = subprocess.run(ssh + [target, 'python3 -c ' + shlex.quote(CONTAINER_PROBE)],
                                           check=True, capture_output=True, text=True, timeout=25)
                print(json.dumps(json.loads(isolation.stdout)))
                result = subprocess.run(ssh + [target, 'python3 -c ' + shlex.quote(REMOTE_PROBE)],
                                        input=json.dumps({'token': token}), text=True,
                                        capture_output=True, timeout=20)
                # Remote script prints only a fixed diagnostic schema, never the token.
                report = json.loads(result.stdout)
                report['remote_bind'] = listeners[0]
                report['scope'] = 'synthetic_host_transport_only_not_api_replica_integration'
                print(json.dumps(report, ensure_ascii=False))
                if result.returncode:
                    raise RuntimeError('remote classification probe failed')
            finally:
                subprocess.run(ssh + ['-S', control, '-O', 'exit', target],
                               capture_output=True, timeout=15)
            remaining = subprocess.run(ssh + [target, 'ss -H -ltn sport = :19092'],
                                       check=True, timeout=15, capture_output=True, text=True)
            if remaining.stdout.strip():
                raise RuntimeError('remote listener still present after tunnel shutdown')
            print(json.dumps({'tunnel_closed': True, 'remote_listener_removed': True}))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == '__main__':
    main()
