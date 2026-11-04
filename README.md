# Apple Globalcare CRM

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/AmberGitOne/appledb)

Deploying: see [DEPLOY.md](DEPLOY.md). The button above reads `render.yaml`
and provisions the service, its persistent disk and its environment in one
step. Note that Vercel cannot host this as built — DEPLOY.md explains why.

A working full-stack build of the Apple Globalcare CRM prototype: the original
single-file HTML UI, now backed by an Express REST API and a real PostgreSQL
database with a normalised relational schema.

The prototype kept everything in one `localStorage` key. This project replaces
that with 38 tables, foreign keys, indexes, constraints, transactions and an
append-only audit trail, without changing how the UI looks or behaves.

---

## Quick start

On Windows, double-click **`START.bat`**. It installs dependencies and builds
the database the first time, then starts the server and opens the app.

Or do it by hand:

```bash
npm install
```

```bash
npm run setup
```

```bash
npm start
```

Then open **http://localhost:4000**.

No C++ toolchain is needed: `pg` is pure JavaScript, and the committed
`.npmrc` sets `ignore-scripts=true` so nothing tries to build from source.
Install takes a couple of seconds.

The database is **PostgreSQL**, set by `DATABASE_URL` (or `POSTGRES_URL`,
which Vercel provides). There is no local-file mode — a serverless host has
no writable disk, so the SQLite this started on could not follow it there.

If you do not have a Postgres to point at, the repo brings its own:

```bash
npm run db:local     # leave running; prints the DATABASE_URL to use
```

That starts a real Postgres under `data/pgdata` with no account, no
container and no network. It is a devDependency, so it is never deployed.

Optionally copy `.env.example` to `.env` to change the port, database path or
JWT secret. The app runs on sensible defaults without it.

`npm run setup` creates the schema and loads the demo data. `npm start` serves
both the API and the browser app on the same port.

To wipe and reload the demo data at any time:

```bash
npm run reset
```

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run the server (API + web app) on port 4000 |
| `npm run dev` | Same, restarting on file changes |
| `npm run migrate` | Apply `schema.sql` (no-op if already applied) |
| `npm run seed` | Load the demo dataset |
| `npm run setup` | migrate + seed |
| `npm run reset` | Rebuild the schema from scratch and reseed |
| `npm test` | End-to-end smoke test against a running server |

---

## Layout

```
server/
  index.js              Express app, static hosting, error handling
  db/
    schema.sql          the entire relational model
    index.js            pg pool, ? -> $n, transactions via AsyncLocalStorage
    migrate.js          migration runner, checksum-tracked
    seed.js             loads data/seed.json into the tables
  lib/
    state.js            maps between SQL rows and the UI's state object
    resource.js         generic REST CRUD factory over a table
    audit.js            append-only audit trail
    http.js             typed errors, pagination
  middleware/
    auth.js             JWT + role-based permissions
  routes/
    index.js            mounts every resource
    state.js            GET/PUT the whole app state, POST reset
    auth.js             login, logout, me, users, roles
    reports.js          aggregate queries for the dashboards
    audit.js            read the audit trail
web/
  index.html            the prototype markup          (generated)
  app.css               the prototype styles          (generated)
  app.js                the prototype logic, persistence re-pointed at the API (generated)
  boot.js               screen routing and the role switcher (generated)
  api.js                the API client that replaced localStorage
  mobile.css            phone and tablet layout
  mobile.js             the navigation drawer
scripts/
  build-frontend.js     regenerates web/ from the prototype HTML
  dev-postgres.js       a local Postgres for development (npm run db:local)
  smoke-test.js         51-assertion end-to-end test
data/
  seed.json             demo data extracted from the prototype
  pgdata/               local Postgres cluster, if you use npm run db:local
```

---

## On a phone

The app is usable on a phone and a tablet, not just a desktop.

The prototype was built at a fixed 1440px and, below 1024px, simply hid the
sidebar and replaced it with a horizontal strip containing all 77
destinations. `web/mobile.css` and `web/mobile.js` replace that:

- the real sidebar becomes an off-canvas **drawer** - tap the menu button,
  tap a destination, or swipe left / press Escape / tap the backdrop to close
- wide tables scroll sideways inside their card instead of being clipped
- KPI tiles wrap by available width: 1 up at 320px, 2 up on a normal phone,
  4 up on a tablet
- step bars and tab strips scroll horizontally rather than stacking
- form fields render at 16px so iOS does not zoom the page on focus
- tap targets are at least 40px
- layout respects notch safe areas

Verified at 320, 360, 375 and 768px: no clipped content on any of 20 screens,
and no horizontal page scroll.

Both files are hand-maintained. `web/index.html`, `app.css`, `app.js` and
`boot.js` are **generated** by `scripts/build-frontend.js`, so mobile styles
must never be folded into `app.css` - a rebuild would erase them. The build
links both files and fails loudly if either goes missing.

---

## The database

38 tables, 51 indexes, 5 views, 7 triggers (plus `schema_migrations`, which the
migration runner uses for its own bookkeeping). Foreign keys are enforced
(`PRAGMA foreign_keys = ON`) and the journal runs in WAL mode so reads do not
block on a write.

**Core groups**

- **Access** — `users`, `roles`, `permissions`, `role_permissions`
- **Reference** — `desks`, `settings`, `routing_rules`, `labels`, `notifications`
- **Cases** — `cases`, `case_timeline`, `case_documents`
- **Service desk** — `tickets`, `ticket_messages`, `ticket_labels`, `attachments`
- **Sourcing** — `rfqs`, `rfq_lines`, `quotes`, `quote_options`
- **Fulfilment** — `orders`, `wave_lines`
- **Quality** — `qa_batches`, `qa_checks`, `qa_deviations`
- **Pharmacy** — `prescriptions`, `rx_checks`, `rx_queries`
- **Supply base** — `suppliers`, `supplier_certificates`
- **People** — `employees`, `benefits`, `employee_benefits`, `leave_requests`, `holidays`, `holiday_requests`
- **Cross-cutting** — `activity_log`, `audit_log`

**Views** — `v_desk_workload`, `v_ticket_counts`, `v_order_pipeline`,
`v_case_overview`, `v_expiring_certificates`. The reporting endpoints read
these rather than rebuilding the aggregates in JavaScript.

**Constraints** are not decorative. Priorities, folders, statuses, severities
and FEFO flags are all `CHECK`-constrained, so an invalid value is rejected by
the database rather than silently stored. The API turns those rejections into
`400` and `409` responses.

The schema is written in portable SQL, so moving to PostgreSQL mainly means
swapping the driver and the `AUTOINCREMENT` / `datetime('now')` idioms.

---

## How persistence works

The prototype's whole storage layer was two functions:

```js
function load(){ return JSON.parse(localStorage.getItem(KEY)) }
function save(){ localStorage.setItem(KEY, JSON.stringify(S)) }
```

Those are now the only two things that changed in the app logic:

- `load()` returns the state that `web/api.js` fetched from `GET /api/state`
- `save()` hands the state to the API client, which debounces a `PUT /api/state`

`GET /api/state` builds the state object out of SQL — selects, joins and
grouped children (threads onto tickets, checks onto batches, certificates onto
suppliers). `PUT /api/state` does the reverse, and it **reconciles rather than
overwrites**: it loads what is stored, compares it against what arrived, and
issues only the `INSERT` / `UPDATE` / `DELETE` statements that correspond to
real changes — all inside one transaction.

That transaction is worth a note. Statements are asynchronous, so a
transaction cannot simply be "the next few statements" the way it was under a
synchronous driver. `server/db/index.js` keeps the open transaction in an
`AsyncLocalStorage`, and every statement looks there first: call sites go on
using the shared `db`, while two concurrent saves can never land in each
other's transaction.

That matters for two reasons. Saving unchanged state writes nothing and
produces no audit noise. And when something does change, the audit row records
exactly which columns moved:

```
update  tickets  TK-58114  before {"starred":0}  after {"starred":1}
```

The UI also gets a small status pill in the corner: *Saving… / Saved · 3 rows /
Not saved — <reason>*, so a failed write is visible instead of silent.

---

## API

Every endpoint is under `/api`. All values reaching SQL are bound parameters;
the only interpolated identifiers are column names checked against the table
definition.

### State

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | Whole app state, assembled from SQL |
| `PUT` | `/api/state` | Persist it back, transactionally |
| `POST` | `/api/state/reset` | Re-seed the demo data |

### Resources

`tickets`, `cases`, `orders`, `wave`, `rfqs`, `quotes`, `qa`, `deviations`,
`prescriptions`, `rx-queries`, `suppliers`, `employees`, `leave`, `holidays`,
`labels`, `notifications`, `routing-rules`, `desks`.

Each supports:

```
GET    /api/<resource>?page=&limit=&sort=&order=&q=&<column>=
GET    /api/<resource>/:id          (expands child collections)
POST   /api/<resource>
PATCH  /api/<resource>/:id
DELETE /api/<resource>/:id
```

Examples:

```bash
curl "http://localhost:4000/api/tickets?folder=inbox&priority=Urgent&limit=5"
```

```bash
curl "http://localhost:4000/api/suppliers?country=Germany&status=Approved"
```

```bash
curl "http://localhost:4000/api/tickets?q=parcel&sort=time_label&order=desc"
```

```bash
curl "http://localhost:4000/api/suppliers/SUP-014"
```

### Reports

```
GET /api/reports/summary                 headline counts for the Command Centre
GET /api/reports/desks                   workload per desk
GET /api/reports/tickets-by/:dimension   channel | desk | priority | folder | status
GET /api/reports/pipeline                orders by stage
GET /api/reports/cases                   cases with related record counts
GET /api/reports/qa-progress             batch release progress
GET /api/reports/expiring-certificates   compliance watch list
GET /api/reports/leave-by-department
GET /api/reports/sourcing/:rfqId         the sourcing spread for one RFQ
```

### Auth and audit

```
POST /api/auth/login        { email, password } -> JWT
POST /api/auth/logout
GET  /api/auth/me
GET  /api/auth/accounts     the sign-in page's picker (demo builds only)
GET  /api/auth/users
GET  /api/auth/roles
GET  /api/audit?entity=&entityId=&userId=&page=&limit=
GET  /api/health
```

---

## Accounts

### The sign-in page

Open `/login` at any time, or sign out from the button beside your name in
the top bar. With `REQUIRE_AUTH=true` it is also what you get at the root
URL until you have a token.

In a demo build it lists the seeded accounts. Picking one signs in and drops
you on that person's desk: Dr. Sara lands on Pharmacy, Yusuf on Sourcing,
Maria on Sales. The top bar then shows the account you signed in as, not the
prototype's placeholder name for that desk.

The picker is only ever a shortcut that fills the form in - `POST
/api/auth/login` still checks the bcrypt hash, and it is the only way in.
It is served by `GET /api/auth/accounts`, which is public (you need it
before you have a token) and therefore discloses who exists. That is why it
answers with nothing at all unless `DEMO_LOGIN` is on, which it is not
under `NODE_ENV=production`, and which `render.yaml` also sets to
`false` outright. Without it the page is an ordinary email and password
form.

`web/login.js` and `web/login.css` are hand-maintained, like
`web/api.js` and the `mobile.*` pair - the build links them but never
generates them.

### The seeded users

Six users are seeded across six roles (Admin, Manager, Agent, Pharmacist,
QA officer, Viewer), with 60 permissions mapped across them.

| Email | Role |
| --- | --- |
| `raj@appleglobalcare.com` | Admin |
| `maria@appleglobalcare.com` | Manager |
| `priya@appleglobalcare.com` | Agent |
| `sara@appleglobalcare.com` | Pharmacist |
| `arun@appleglobalcare.com` | QA officer |
| `yusuf@appleglobalcare.com` | Agent (sourcing) |

Password for all of them: `Welcome@123`

**Authentication is wired up but not enforced by default**, so the app opens
straight into the CRM the way the prototype did. Passwords are bcrypt-hashed,
logins are audited, and roles carry real permission sets. To lock the API down,
add this to `.env` and restart:

```
REQUIRE_AUTH=true
```

Every route then requires a bearer token or session cookie, and
`requires('tickets:update')`-style guards start rejecting under-privileged
roles with `403`.

---

## Configuration

`.env`:

```
PORT=4000
NODE_ENV=development
DATABASE_URL=postgres://crm:crm@127.0.0.1:5433/crm
JWT_SECRET=change-me-in-production-aglc-crm-secret
TOKEN_TTL=12h
REQUIRE_AUTH=false
DEMO_LOGIN=true
```

Change `JWT_SECRET` before putting this anywhere real, and change the seeded
passwords too - `DEMO_LOGIN=true` publishes the shared one on the sign-in
page, so keep it off anywhere the URL is not just yours.

---

## Tests

```bash
npm test
```

45 assertions covering read paths, filtering, search, pagination, nested
expansion, create/update/delete, constraint handling (409 on duplicate key,
400 on a CHECK violation), state round-tripping, cascade deletes, foreign-key
and `integrity_check` verification, login success and failure, and the reset
path. The test restores the seeded dataset when it finishes.

---

## Rebuilding the frontend

`web/` is generated from the prototype HTML, so an updated prototype can be
folded in without hand-editing:

```bash
node scripts/build-frontend.js "C:\Users\lenovo\Downloads\AppleGlobalcare-CRM.html"
```

It splits the file into `index.html` / `app.css` / `app.js` / `boot.js` and
re-applies four patches: `load`/`save` to the API, the *Reset demo data*
button, and deferring `__crmInit` and `applyRole` until the state has loaded.
If the prototype changes so much that a patch no longer matches, the build
fails loudly rather than producing a half-wired app.

---

## Notes on the source data

Two things in the prototype's seed data did not survive contact with a real
schema, and were handled rather than papered over:

1. **Five duplicate ticket IDs.** `TK-58112`, `TK-58116`, `TK-58118`,
   `TK-58122` and `TK-58123` each appeared twice. As a plain array in
   `localStorage` this went unnoticed; a primary key will not allow it. All 41
   tickets are kept and the repeats were reissued as `TK-58200`–`TK-58204`.
   The seeder prints the remapping each time it runs.

2. **Values outside their apparent enum.** Prescriptions used `status:
   'queue'`, and leave used `recorded` and `lop`. The `CHECK` constraints were
   widened to match the real data instead of coercing the values.

Supplier references are resolved by name where the data genuinely agrees
(`Nordic Rare Therapeutics` to `Nordic Rare Therapeutics ApS`), and left null
where it does not — `Meridian Specialty Rx` in the RFQ is a different company
from `Meridian Clinical Supplies Ltd` in the supplier master, so no link is
invented.

`localStorage` is still used, deliberately, for three UI preferences that are
per-browser rather than per-record: theme, last screen, and the selected role
in the *View as* switcher.
