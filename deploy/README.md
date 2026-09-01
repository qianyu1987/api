# Production Deployment

Release `v1.0.9` serves `https://api.hhtc.top` from `101.35.223.148` without publishing PostgreSQL, Redis, or an API container port. The only host-facing listener is the loopback gateway at `127.0.0.1:18082`.

## First Release

1. Clone this repository to `/opt/relay-station` and create `.env` from `.env.example`. Replace every placeholder secret before starting the service.
2. Create `/opt/relay-station/secrets` as `root:1000` with mode `0750`. Put payment certificates there only when payment credentials are ready, with mode `0640` and group `1000`, so the unprivileged API container can read them.
3. Run `docker compose config --quiet`, then `docker compose up -d --build --scale api=2 gateway`.
4. Back up the current `api.hhtc.top` Nginx virtual-host file, install `deploy/nginx/api.hhtc.top.conf`, run `nginx -t`, then reload Nginx.
5. Install `deploy/systemd/relay-station-worker.service` and `.timer`, reload systemd, and enable the timer.
6. Verify `curl -fsS https://api.hhtc.top/healthz` returns JSON with `ok: true` before configuring payment callbacks.

## Upgrade

1. Take a PostgreSQL-consistent backup before deployment.
2. Pull the target tag and run `docker compose build`.
3. Run `docker compose run --rm migration`.
4. Run `docker compose up -d --no-deps --scale api=2 api gateway`.
5. Verify the health endpoint and `docker compose ps`.

Do not run `docker compose down -v` during normal operation. It destroys the PostgreSQL and Redis volumes.
