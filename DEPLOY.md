# Deploying

## Picking a host

The database is PostgreSQL, reached over the network, so the app itself
needs nothing from the filesystem. Any host will do:

| Host | What it needs |
| --- | --- |
| Vercel, or any serverless host | a Postgres; `POSTGRES_URL` is set for you by the integration |
| Render, Railway, Fly, a VPS | the same, as `DATABASE_URL` |
| Your laptop | `npm run db:local`, which brings its own Postgres |

There is deliberately no local-file mode. Serverless hosts run on a
read-only filesystem whose only writable path, `/tmp`, is wiped between
invocations and not shared between instances, so a file-backed database
would lose writes and serve different data to different users. Rather than
support a mode that silently breaks in one deployment target,
`server/db/index.js` requires a connection string and says so if it is
missing.

---

## Vercel + Postgres

**1. Add a Postgres from inside Vercel.** Project → Storage → Create, and
pick a Postgres provider from the marketplace (Neon is the default). This
does not need a separate signup - it is provisioned against your Vercel
account, and it sets `POSTGRES_URL` on the project automatically.

**2. Set the rest of the environment** (Settings → Environment Variables),
for all three environments:

```
NODE_ENV        production
REQUIRE_AUTH    true
DEMO_LOGIN      false
DEMO_PASSWORD   <a password of your own>
JWT_SECRET      <a long random string>
```

Generate the secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`DEMO_PASSWORD` is not optional here. Every seeded account shares one
password, and this repository's default is public in `server/lib/demo.js`,
so a deployment that used it would be an open system behind a login form.
The boot step refuses to seed under `NODE_ENV=production` while the default
is still in place, and says so.

It has to be set **before the first request**, because that is what creates
the accounts; setting it afterwards changes nothing. To change it later,
drop the tables and let the next request rebuild them, or update the hashes
directly.

**3. Deploy.** Nothing else to do: the first request prepares the database
itself. `vercel.json` routes every request to `api/index.js`, which hands
it to the same Express app the server uses. There is no `listen()` there;
the app is invoked per request, and `ready()` resolves the connection once
per instance.

### Put the database in the function's region

This matters more than it looks. The first request runs a migrate and a
seed, which is about 735 sequential statements - almost no work, but one
round trip each. Co-located, that is ~2 seconds. Measured from India
against `aws-us-east-1`, with a 205ms round trip, the same boot took
**150 seconds**.

A serverless function is killed at `maxDuration`, and seeding runs in a
transaction, so a kill rolls it back and the next request starts over and
is killed at the same point - a loop that never converges. So the boot
measures the round trip first and refuses outright if the arithmetic does
not fit in `BOOTSTRAP_BUDGET_MS` (20s by default, under the 60s
`maxDuration` in `vercel.json`), telling you to co-locate or to load the
schema yourself. It does not start work it cannot finish.

Vercel functions default to `iad1`, which is `us-east-1`. Match it, or set
both to whichever region you prefer.

### The first request

Vercel runs a function, not a start command, so there is nowhere to put a
deploy step like Render's `node server/db/bootstrap.js`. The first cold
start does it instead - `AUTO_BOOTSTRAP`, which defaults on whenever
`VERCEL` is set.

It costs nothing once the database is populated: the fast path is two
queries, and it never reaches the migration runner. When the database *is*
empty it takes a Postgres advisory lock first, because a deploy's opening
burst of traffic cold-starts several instances at once and each would
otherwise try to create the same tables. The lock lives on its own
connection, so an instance that dies cannot leave it held.

Schema changes after that first deploy stay deliberate - this only builds a
database that has no users yet. When `schema.sql` moves forward, run the
migration yourself against `POSTGRES_URL`:

```powershell
$env:DATABASE_URL="postgres://..."; npm run migrate
```

```bash
DATABASE_URL="postgres://..." npm run migrate   # bash/zsh
```

Note the two forms. PowerShell has no inline `VAR=value command` syntax -
it reads the whole thing as a command name and reports that it does not
exist.

### Connections

Each warm instance holds its own pool, so the pool is capped at one
connection when `VERCEL` is set - a bigger pool per instance just exhausts
the server's slots under load.

Serve traffic through the **pooled** connection string when the provider
offers both. Neon's is the host with `-pooler` in it, and pooling matters
most here, where a burst of cold starts each wants a connection at once.

But set the **direct** string as well, under either name the providers use:

```
DATABASE_URL_UNPOOLED        (Neon)
POSTGRES_URL_NON_POOLING     (the Vercel integration)
```

Neon's pooled endpoint is PgBouncer in transaction mode, which does not
keep a client on one backend between statements, so nothing session-scoped
can be trusted through it. The first-boot lock is exactly that, and it
takes the direct string when one is published. `POSTGRES_URL` alone still
works - a single endpoint is used for both - but on Neon the lock is then
only as reliable as the pooler, so set both.

Run schema migrations over the direct string too:

```powershell
$env:DATABASE_URL="postgres://...  (no -pooler)"; npm run migrate
```

### TLS

Certificates are verified. Hosted Postgres presents one from a public CA,
which Node's bundled roots accept without configuration, and a local
server is detected by its address and connects without TLS at all.

`DB_SSL_NO_VERIFY=true` turns verification off for a provider that only
offers a self-signed certificate. Prefer not to: TLS without verification
hides traffic from a passive observer but not from anything in the path,
which for a database connection carrying every record and session token is
most of the point.

### Encoding

Create the database as UTF8. The demo data contains characters outside
Latin-1, and a WIN1252 database fails partway through seeding with an
encoding error rather than at the start. Hosted Postgres is UTF8 by
default; this is only a trap for a database you create yourself on Windows,
which is why `npm run db:local` states the encoding explicitly.

---

## Render (blueprint included)

`render.yaml` is committed, so Render can provision everything itself.

1. Push this repo to GitHub.
2. Render dashboard → **New** → **Blueprint** → select the repo.
3. Confirm. Render reads `render.yaml` and creates the web service plus a
   managed Postgres, wiring `DATABASE_URL` between them.

The blueprint's start command is `node server/db/bootstrap.js && node
server/index.js`. `bootstrap.js` applies the schema and seeds the demo data
**only when the database has no users** — so the first deploy comes up with a
working account to sign in with, and every later deploy leaves your real data
alone.

The blueprint sets:

- `DATABASE_URL` — taken from the managed Postgres the blueprint creates,
  so the data outlives the instance
- `REQUIRE_AUTH=true` — the app is reachable from the internet, so it should
  not be open
- `JWT_SECRET` — generated by Render, never committed

There is no disk to pay for any more, but Render's free Postgres expires
after 30 days, so the blueprint asks for a paid database tier. The web
service itself can run on a smaller plan if you prefer.

### First sign-in

The deploy seeds the demo accounts. Sign in with any of them:

| Email | Role |
| --- | --- |
| `raj@appleglobalcare.com` | Admin |
| `priya@appleglobalcare.com` | Agent |

Password: `Welcome@123`

**Change these immediately on a public deployment.** They are fixtures, not
credentials.

---

## Docker (Railway, Fly.io, a VPS, locally)

```bash
docker build -t aglc-crm .
```

```bash
docker run -p 4000:4000 -e DATABASE_URL="postgres://..." -e REQUIRE_AUTH=true -e JWT_SECRET="$(openssl rand -hex 32)" aglc-crm
```

No volume is needed. The container holds no data - `DATABASE_URL` points at
a Postgres somewhere else, and the image can be replaced at will.

`docker-entrypoint.sh` runs the same `bootstrap.js`: schema applied every
boot, demo data loaded only when there are no users. A redeploy never wipes
real records.

### Railway

Railway detects the `Dockerfile` automatically. Add a volume mounted at
`/app/data`, then set `REQUIRE_AUTH=true` and a `JWT_SECRET` in the service
variables.

### Fly.io

```bash
fly launch --no-deploy
```

```bash
fly volumes create crm_data --size 1
```

Mount it at `/app/data` in `fly.toml`, then `fly deploy`.

---

## Before any public deployment

- [ ] `REQUIRE_AUTH=true` — otherwise anyone with the URL has full write access
- [ ] `JWT_SECRET` set to a long random value, never the one in `.env.example`
- [ ] Demo account passwords changed, or those users removed
- [ ] The database is on a **persistent volume**, not the container filesystem
- [ ] `NODE_ENV=production`

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## How auth behaves

With `REQUIRE_AUTH=false` (the local default) the app opens straight into the
CRM, as the prototype did.

With `REQUIRE_AUTH=true`:

- `/api/health` and `/api/auth/login` stay public — everything else returns
  `401` without a valid bearer token
- The browser app shows a sign-in screen, stores the token, and retries
- If the token expires mid-session, the next save prompts for sign-in and then
  retries that save, so the edit is not lost
- Role permissions are enforced server-side: an Agent reading `/api/audit`
  gets `403`, as does an Agent trying to delete a supplier
- Audit rows are attributed to the signed-in user rather than a fallback

---

## Backing up

```bash
pg_dump "$DATABASE_URL" --no-owner --format=custom --file="backup-$(date +%F).dump"
```

Restore with `pg_restore --clean --no-owner --dbname "$DATABASE_URL"`.

Most hosted providers also take their own snapshots - Neon keeps a restore
window, and Render backs up daily on the paid tiers - so this is for copies
you want to hold yourself.
