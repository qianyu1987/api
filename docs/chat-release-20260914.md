# 2026-09-14 AI chat release

Deployed image: relay-station:chat-20260914 (80c18844b2ce).
Rollback image: relay-station:rollback-chat-20260914.
Production backup: /opt/relay-backup-chat-20260914 (database.dump, source, public, compose).
Nginx backup: /opt/relay-domain-backup-20260914/www.hhtc.top.conf.

hhtc.top and www.hhtc.top now proxy to the Relay gateway, with a dual SAN certificate expiring 2026-12-13. Existing loopback legacy origin and unrelated virtual hosts remain. No working mini-program /api/v1 route was found on this server; prior naked-domain HTTPS had a certificate mismatch. The /api/v1/ path preserves the previous default HTTPS backend, but mini-program functionality has NOT been verified.

/chat is authenticated, fixed to Agnes3, billed with current gpt-5.6-sol price and selected channel snapshot. Limits are 500 attempts/user/day and 1500 site-chat attempts/platform/day at Beijing midnight. Other uses of the upstream account do not count toward this local cap. Failed attempts consume the attempt quota but release monetary reservation. User conversations are soft-deleted. Messages are plain text and returned after generation, not streamed.

Recovery: persisted answer plus settlement payload; recover pending turns older than two minutes from history/send and maintenance worker. Generic reservation expiry skips pending chat turns. Tests cover ownership, replay, input, date boundaries, answer settlement recovery and abandoned releases. Concurrent quota integration tests and authenticated mobile/browser flow remain to be completed.

Verification: 177 tests passed using copied production source + changed files on isolated Linux directory; typecheck/build passed; local syntax/diff checks passed. Real production admin service smoke returned completed, replay matched, one usage record, settled reservation; test conversation archived. Both replicas/gateway/Postgres/Redis healthy; worker Result=success. All three domains / and /chat return200; unauthenticated quota returns401. Homepage filing link verified in HTML; login screenshot checked. No claim of complete authenticated visual QA.
