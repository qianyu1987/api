# Laya shadow router

This service runs only on an Apple silicon Mac. It is an observation-only classifier until a measured routing policy is explicitly enabled in Relay Station.

Runtime files and model weights are intentionally kept outside the repository:

```text
/Volumes/brainos/CodexMedia/generated/laya-mlx-shadow
```

Evaluate the fixed sample set:

```bash
RUNTIME=/Volumes/brainos/CodexMedia/generated/laya-mlx-shadow
"$RUNTIME/.venv/bin/python" tools/laya-shadow/evaluate.py \
  --model "$RUNTIME/models/laya-multilingual-mlx"
```

Start the loopback-only service:

```bash
RUNTIME=/Volumes/brainos/CodexMedia/generated/laya-mlx-shadow
export LAYA_SHADOW_TOKEN='use-a-random-local-secret'
"$RUNTIME/.venv/bin/python" tools/laya-shadow/server.py \
  --model "$RUNTIME/models/laya-multilingual-mlx"
```

`GET /healthz` is unauthenticated. Startup requires `LAYA_SHADOW_TOKEN`;
`POST /v1/classify` requires that bearer token. Only `127.0.0.1` and one
concurrent inference are supported. This remains a local prototype, not a
production HTTP ingress.

The built-in 41 cases are agent-authored synthetic smoke cases, including
previously tuned examples. They are not an independent holdout or evidence of
production accuracy. Tool-need labels depend on available product capabilities.

For reproducible evaluation, add `--report /absolute/path/report.json`. Reports
omit prompt text and include case indices, dataset/question hashes and confusion
counts. `--cases /absolute/path/cases.json` accepts a nonempty JSON array:

```json
[{"text":"Translate hello into Chinese", "expected_type":"text", "expected_tools":false}]
```

External data is marked unverified: its provenance, human labels and separation
from tuning must be reviewed before calling it an independent evaluation.
No score from this script enables routing. Run HTTP boundary tests with the
runtime Python: `python -m unittest discover -s tools/laya-shadow -p 'test_*.py'`.

## Relay integration status (not deployed)

`src/services/laya-shadow.ts` observes eligible requests after successful billing
reservation. Its return value is never used for routing or settlement. It is
disabled unless `LAYA_SHADOW_ENABLED=true`, a 32-character-or-longer
`LAYA_SHADOW_TOKEN`, an explicit `LAYA_SHADOW_ADMIN_USER_ID`, and
`LAYA_SHADOW_URL=http://127.0.0.1:<port>/v1/classify` are configured.

The pilot only accepts that authenticated administrator's API requests with one
plain user message (or a Responses string input), up to 2000 characters. History,
tools, files, metadata and unknown request fields are excluded. Only text is sent;
API keys, user IDs and headers are not forwarded. One in-flight request per API
replica, a 750 ms deadline, a 16 KiB result limit, no retries and no queue bound
resource use. The normal API response does not wait for classification.

`GET /api/admin/laya-shadow` requires the existing administrator session and
returns counts only. Counts are process-local, reset on restart, and are **not**
accuracy measurements or combined statistics across replicas.

The switch stays off by default. Enabling it requires, in host `.env`:
`LAYA_SHADOW_ENABLED=true`, the 32+ character `LAYA_SHADOW_TOKEN`, an explicit
`LAYA_SHADOW_ADMIN_USER_ID` and `LAYA_SHADOW_SOCKET_PATH=/run/laya-shadow/classifier.sock`
(the transport is chosen by the socket path; URL mode is still restricted to
loopback). The actual sampling scope — which administrator API key to observe —
remains an explicit user decision. There is no automatic routing mode in this
implementation, and no evaluation score enables one.

## Local web observation console

`dashboard/dashboard.py` + `dashboard/dashboard.html` run a loopback-only web
console on `127.0.0.1:19095` (override with `--port`). It observes and
demonstrates the shadow pipeline without changing any server configuration:

- component liveness (classifier `:19091`, `transport_supervisor.py`, recent
  `transport.log` / `supervisor.log` events, in-process model state),
- in-process single-classification with full per-option probabilities, noul
  value, confidence and latency (concurrency 1, shared MLX model; prompt text
  is never logged and nothing is forwarded anywhere),
- the built-in evaluation set (quick 15-case or full 41-case runs) with
  confusion counts and per-case latencies,
- live JSON log tails and the historical report files in the runtime directory.

Start it detached with the runtime Python:

```bash
RUNTIME=/Volumes/brainos/CodexMedia/generated/laya-mlx-shadow
nohup "$RUNTIME/.venv/bin/python" tools/laya-shadow/dashboard/dashboard.py >>"$RUNTIME/dashboard.log" 2>&1 &
```

Then open `http://127.0.0.1:19095`. The console adds its own model instance;
if the supervisor's classifier (`:19091`) is running, both hold the model in
memory. Observation only: it reads logs and manifest files, performs no SSH,
and no prompt content is written to any log.

## Ephemeral private transport probe

`probe_transport.py --model /absolute/model/path` loads a fresh local classifier
with an in-memory random token and starts an SSH reverse tunnel on the fixed
production host's `127.0.0.1:19092`. It verifies the effective listener is
loopback-only before sending one synthetic coding prompt, verifies 401 without
the token and 200 with it, then closes the tunnel and checks the listener is gone.
It uses the recorded SSH identity with strict host-key checking and does not
change server configuration or website processes. Port conflicts fail closed.

Verified 2026-09-24: unauthorized 401, authorized 200/shadow, task coding,
local inference 57.8 ms; tunnel cleanup verified. This proves only the **host to
Mac** transport. API containers still need a private transport endpoint in their
own network namespace (or an explicitly implemented Unix socket transport).
It is not evidence of deployed shadow sampling or real routing.

The probe now also runs bounded health requests from **both** existing API
containers to container loopback and the inspected backend gateway. With the
host-only tunnel active, all four checks returned `ECONNREFUSED` on 2026-09-24,
while the host classification succeeded. This is an isolation test, not a
successful container connection. No prompt or token is sent by container checks.

## Persistent Unix-socket transport supervisor

`transport_supervisor.py` implements the private transport for both API
replicas. It runs only on the Mac and owns:

1. the local classifier (`server.py` on `127.0.0.1:19091`),
2. a stateless host bridge (`laya_shadow_bridge.py`, stdlib-only, restarted
   per cycle) that listens on `/opt/laya-shadow/classifier.sock` and pipes
   each connection to the host loopback `127.0.0.1:19093`,
3. one SSH master that forward-binds that loopback TCP port to the Mac
   classifier. The host OpenSSH (7.4) cannot bind a Unix socket via -R, so
   the bridge owns the socket; no TCP listener is exposed on the Docker
   bridge,
4. socket permission repair (`chgrp 1000`, group-writable) so the
   unprivileged container user can connect, and
5. host-side synthetic verification after every reconnect: `/healthz` 200,
   unauthenticated classify 401, authenticated classify 200/shadow.

Host prerequisite (idempotent, also performed by the supervisor):

```sh
install -d -m 0750 -o root -g 1000 /opt/laya-shadow
```

`docker-compose.yml` mounts `/opt/laya-shadow` read-only into the two API
replicas at `/run/laya-shadow`. The relay side already accepts only
`LAYA_SHADOW_SOCKET_PATH=/run/laya-shadow/classifier.sock` plus a loopback URL,
and dispatches it with a single-connection Undici Unix-socket agent
(`src/services/laya-shadow.ts`). No TCP listener is exposed on the Docker
bridge and no SSH config change is required. When the SSH master or the local
classifier dies, the supervisor sleeps five seconds, restarts the bridge and
the tunnel, repairs permissions and re-verifies. A missing or broken socket
only increments shadow failure counters; user requests, routing and billing
are unaffected. The bridge file itself ships in the repository but is not
part of the container image; the host runs it from the synced
`/opt/relay-station/tools/laya-shadow/` directory.

Run it detached:

```bash
RUNTIME=/Volumes/brainos/CodexMedia/generated/laya-mlx-shadow
nohup "$RUNTIME/.venv/bin/python" tools/laya-shadow/transport_supervisor.py >>"$RUNTIME/supervisor.log" 2>&1 &
```

The persistent 0600 token lives in `$RUNTIME/transport-token`; it is never
printed and is only added to the host `.env` when the observation switch is
explicitly enabled. Until then the switch stays off and no website prompt is
transmitted. Unit tests: `python -m unittest discover -s tools/laya-shadow -p 'test_*.py'`
covers the SSH argument builders, host commands, the token-printing invariant of
the verify script, and a local Unix-socket HTTP round trip.
