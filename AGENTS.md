# Production access

- Production host: `101.35.223.148`, SSH user: `root`.
- Existing SSH identity: `/Volumes/brainos/MacStorage/Downloads/111.pem`.
- Both `www.hhtc.top` and `api.hhtc.top` belong to this host. Never deploy this project to `124.223.74.26`.
- Use `ssh -i /Volumes/brainos/MacStorage/Downloads/111.pem -o BatchMode=yes -o ConnectTimeout=10 root@101.35.223.148` and test the existing identity before reporting any authentication problem. Do not ask the user to restore public-key access without an actual failed connection using this identity.
- Production working directory: `/opt/relay-station`. Preserve other applications on this shared host.
- Never print or copy the SSH private key, API credentials, database passwords, or cookies into logs or reports.
- Back up the production database and affected configuration before deployment. Keep the previous image and verify both API replicas after deployment.
