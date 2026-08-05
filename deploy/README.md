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
- `READINESS_TIMEOUT_MS=2000` (optional)

Railway supplies `PORT`. Generate a public domain and probe `/healthz` and `/readyz`.

## Card service variables and volume

- `BOI_PROCESS=card`
- `NODE_ENV=production`
- `DATABASE_URL` — same reference, for the advisory-locked pre-deploy migration
- `BOI_CARD_DIR=/data/cards`
- `BOI_CARD_SIGNING_SECRET` — random, independent of the write secret
- `BOI_CARD_WRITE_SECRET` — random, independent of the signing secret
- `BOI_CARD_PUBLIC_BASE=https://<generated-card-domain>`
- `RAILWAY_RUN_UID=0` — Railway volumes mount as root while the image defaults to a
  non-root user

Mount a persistent Railway volume at `/data/cards`. Railway supplies `PORT`. Generate a
public domain and the matching `RAILWAY_VOLUME_MOUNT_PATH` automatically, then probe
`/healthz`; card reads should remain private signed URLs.

## Live gates deliberately not performed by this commit

1. User authenticates Railway and creates/links the project, Postgres, and two services.
2. User adds secrets through Railway's variable UI or CLI; never paste them into chat.
3. User attaches the card volume and generates both public domains.
4. Deploy and wait for terminal `SUCCESS`, then verify API readiness, card persistence
   across a redeploy, TLS, migrations, and a synthetic Spectrum send before real data.
