# Project memory — read before working

- Read `docs/PROJECT_MEMORY.md` for architecture, business constraints and operating procedures, then `docs/OPERATIONS_LOG.md` for the last verified release and outstanding work.
- These records persist across sessions. Recheck live facts before acting; an old blocker is not evidence of a current blocker, and a code change is not evidence of a deployment.
- After meaningful changes, releases or diagnosis, update the relevant memory with date, evidence, validation, deployed version and unresolved items. Record no secret values or user payment details.
- If current user instructions or live evidence supersede a record, correct that record instead of repeating the outdated assumption.

# Production access

- Production host: `101.35.223.148`, SSH user: `root`.
- Existing SSH identity: `/Volumes/brainos/MacStorage/Downloads/111.pem`.
- Both `www.hhtc.top` and `api.hhtc.top` belong to this host. Never deploy this project to `124.223.74.26`.
- Use `ssh -i /Volumes/brainos/MacStorage/Downloads/111.pem -o BatchMode=yes -o ConnectTimeout=10 root@101.35.223.148` and test the existing identity before reporting any authentication problem. Do not ask the user to restore public-key access without an actual failed connection using this identity.
- Production working directory: `/opt/relay-station`. Preserve other applications on this shared host.
- Never print or copy the SSH private key, API credentials, database passwords, or cookies into logs or reports.
- Back up the production database and affected configuration before deployment. Keep the previous image and verify both API replicas after deployment.
