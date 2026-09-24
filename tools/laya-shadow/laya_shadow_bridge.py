#!/usr/bin/env python3
"""Host-side TCP-to-Unix bridge for the Laya shadow classifier.

CentOS 7 OpenSSH (7.4) cannot -R bind a remote Unix socket. This stdlib-only
bridge, run as root on the host, listens on /opt/laya-shadow/classifier.sock
and pipes each connection to 127.0.0.1:19093, which an SSH -R loopback
forward connects back to the Mac classifier. No TCP listener is exposed on the
Docker bridge; the socket itself is group-restricted so only the API
containers' node user (gid 1000) can connect.
"""
from __future__ import annotations

import os
import socket
import sys
import threading

UNIX_SOCKET = '/opt/laya-shadow/classifier.sock'
TCP_TARGET = ('127.0.0.1', 19093)
GROUP_GID = 1000


def pipe(source: socket.socket, destination: socket.socket) -> None:
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            destination.sendall(data)
    except OSError:
        pass
    finally:
        try:
            destination.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def main() -> int:
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    if os.path.exists(UNIX_SOCKET):
        os.unlink(UNIX_SOCKET)
    server.bind(UNIX_SOCKET)
    os.chmod(UNIX_SOCKET, 0o660)
    try:
        os.chgrp(UNIX_SOCKET, GROUP_GID)
    except (PermissionError, OSError):
        pass
    server.listen(8)
    print('laya-shadow bridge ready on ' + UNIX_SOCKET, flush=True)
    while True:
        connection, _ = server.accept()
        try:
            upstream = socket.create_connection(TCP_TARGET, timeout=3)
        except OSError:
            connection.close()
            continue
        threading.Thread(target=pipe, args=(connection, upstream), daemon=True).start()
        threading.Thread(target=pipe, args=(upstream, connection), daemon=True).start()
    return 0


if __name__ == '__main__':
    sys.exit(main())
