# Railway deployment packet

Create two services from this repository: `boi-api` and `boi-card`. Both must keep the
repository root as their source root because the cloud packages import shared contracts.
Do not configure `source.rootDirectory` for either service. Both services use the root
`Dockerfile` and `railway.toml`.

The shared pre-deploy command runs migrations under a Postgres advisory lock. It is safe
for the two services to deploy concurrently. Both services therefore need the same
managed-Postgres `DATABASE_URL` reference.

## API service variables

- `BOI_PROCESS=api`
- `NODE_ENV=production`
- `DATABASE_URL` — reference the managed Postgres service
- `SPECTRUM_PROJECT_ID`
- `SPECTRUM_PROJECT_SECRET`
- `SPECTRUM_LINE_E164`
- `SPECTRUM_WEBHOOK_SECRET`
- `CONTACT_KEY_ENVELOPE_MASTER_KEY` — canonical base64 encoding of 32 random bytes
- `BOI_CARD_PRIVATE_BASE=http://${{boi-card.RAILWAY_PRIVATE_DOMAIN}}:${{boi-card.PORT}}`
- `BOI_CARD_PUBLIC_BASE=https://${{RAILWAY_PUBLIC_DOMAIN}}` — signed card links stay
  on the API domain and are proxied to the private card service
- `BOI_CARD_WRITE_SECRET` — the same secret reference used by `boi-card`
- `BOI_CARD_PROXY_MAX_BYTES=8388608` (optional)
- `READINESS_TIMEOUT_MS=2000` (optional)
- `BOI_PHASE2_ENABLED=0` — Phase 2 inbound stream + chat, off by default. Set to `1`
  after verifying base deploy health; readys the stream listener and retention worker.
- `BOI_PHASE2_USER_ID` — required only when `BOI_PHASE2_ENABLED=1`. The user_id used
  for stream checkpoint and retention scoping.
- `BOI_LIVE_CHAT_MODEL` — model name (e.g. `gpt-4o`) for live chat selection; unset
  means the offline/decline provider runs, which is correct for staging.
- `BOI_LIVE_CHAT_API_KEY` — API key matching the model; unset when live chat is off.

Railway supplies `PORT`. Generate the project's **only public domain** on this API
service. Railway probes `/readyz`, which verifies Postgres, Spectrum, and the card
service over private networking. `/healthz` remains the process-liveness endpoint.

## Card service variables and volume

- `BOI_PROCESS=card`
- `NODE_ENV=production`
- `DATABASE_URL` — same reference, for the advisory-locked pre-deploy migration
- `BOI_CARD_DIR=/data/cards`
- `BOI_CARD_SIGNING_SECRET` — random, independent of the write secret
- `BOI_CARD_WRITE_SECRET` — random, independent of the signing secret
- `BOI_CARD_PUBLIC_BASE=https://${{boi-api.RAILWAY_PUBLIC_DOMAIN}}`
- `PORT=8080` — set this service variable explicitly so the API's cross-service
  `${{boi-card.PORT}}` reference resolves
- `RAILWAY_RUN_UID=0` — Railway volumes mount as root while the image defaults to a
  non-root user

Mount a persistent Railway volume at `/data/cards`; Railway supplies the matching
`RAILWAY_VOLUME_MOUNT_PATH`. **Do not generate a public domain for this service.** Its
`/cards/*`, `/readyz`, and authenticated deletion endpoint are reachable only through
the Railway private network. The shared config probes `/readyz`; that probe performs a
small create/read/delete cycle on the mounted volume without returning paths or errors.

## Webhook configuration

Photon inbound messages arrive at `POST /v1/webhooks/spectrum`. Configure the webhook
URL in the Photon dashboard to `https://<api-public-domain>/v1/webhooks/spectrum`.
Photon signs each request with an `X-Spectrum-Signature: v0=<sha256>` header; the
SpectrumChannel handler verifies this against `SPECTRUM_WEBHOOK_SECRET`.

The webhook path correctly extracts `sender.address` as the inbound phone number.
(The Phase 2 stream decoder, by contrast, reads `message.sender.id` from the SDK.)

## Live gates deliberately not performed by this commit

1. User authenticates Railway and creates/links the project, Postgres, and two services.
2. User adds secrets through Railway's variable UI or CLI; never paste them into chat.
3. User attaches the card volume and generates only the API public domain.
4. Deploy and wait for terminal `SUCCESS`, then verify API readiness, card persistence
   across a redeploy, TLS, migrations, and a synthetic Spectrum send before real data.
