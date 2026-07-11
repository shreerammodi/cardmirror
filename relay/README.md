# CardMirror relay (self-hosting)

The server behind CardMirror's collaboration features — both **card
sharing** (store-and-forward mailbox) and **co-editing** (real-time
session rooms). Everything is **end-to-end encrypted by the app** —
this server only ever sees opaque ciphertext, a hashed routing code,
and timestamps. Mailbox messages are forgotten after 3 hours whether
or not they were delivered; co-editing rooms hold their (encrypted)
session log until the host ends the session or the room has been idle
for 7 days. New cards and session updates are live-pushed to connected
apps over SSE; the app also catches up by polling on every reconnect,
so nothing is lost while a machine is offline.

Run your own if you'd rather not use the official relay. Everyone
sharing cards with each other must point at the same relay.

## Quick start (docker compose)

```sh
cd relay
RELAY_TOKEN=$(openssl rand -hex 24) docker compose up -d
```

Then in CardMirror on every machine: **Settings → Collaboration** →
**Custom relay URL** = `http://<your-host>:8410/relay`, **Custom relay
token** = the same token. Use HTTPS (a reverse proxy such as Caddy or
your platform's TLS) for anything beyond a LAN.

## Running it elsewhere

Any host that runs a Python process + Postgres works (Railway, Fly,
a VPS…). Requirements:

- env `DATABASE_URL` (Postgres) and `RELAY_TOKEN` (any long random
  string — it's the shared bearer, not the privacy mechanism).
- **Exactly one worker process** (`uvicorn server:app`, no
  `--workers`): the live-push registry is in-process.
- Recommended: `--limit-concurrency 4096` (the Dockerfile sets this) as
  a connection-storm backstop. It counts long-lived SSE streams too, so
  keep it far above the number of apps you expect connected at once.
- Required: `--timeout-graceful-shutdown 5` (the Dockerfile sets this).
  Without it a stopped instance waits forever for its open SSE streams
  and lingers as an unbound zombie that keeps heartbeating old clients
  while the new instance owns the port — their live pushes then go
  nowhere until the clients notice on their own.
- The tables are created automatically on first start.

Health check: `GET /relay/health` → `{"ok": true}` (no auth).

## Notes

- One `RELAY_TOKEN` covers both features — card sharing and co-editing
  sessions authenticate with the same shared bearer.
- Co-editing rooms: at most **10 people** per session (enforced at
  stream connect), 5 MB per update (the app chunks bigger ones),
  200 MB stored per room.
- Payload cap 25 MB decompressed / 30 MB gzipped per send.
- Poll returns at most 100 messages, oldest first; the app deletes
  each message after it lands.
- CardMirror also works against a relay without the `/stream`
  endpoint by falling back to interval polling — but this server
  includes push, so you get instant delivery.
