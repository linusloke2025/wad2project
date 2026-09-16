# Event Coordination

A mobile-first web app for coordinating large events — parades, ceremonies, processions — where
many groups have to move through shared space on a schedule.

**Module:** IS216 Web Application Development 2 — Group Project
**Repository:** https://github.com/linusloke2025/wad2project

---

## The problem

Large events run on coordination that currently happens over Telegram. That leaves three gaps:

1. **No single source of truth** for who moves where, and when.
2. **Bottlenecks are invisible** — two groups double-booked in one zone, or a transition with too
   little time to walk, are only discovered when they happen.
3. **Nothing is learned afterwards.** Once the event is over there is no record of where the
   delays actually were.

This app replaces the *coordination uncertainty*, not chat. It is deliberately **not** a messaging
app: announcements are one-way and responses are a fixed signal, because rebuilding Telegram would
be competing with Telegram on its own ground.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vue 3, Vite, Pinia, Vue Router, Bootstrap 5 |
| Backend | Node.js, Express 5 |
| Database | MongoDB (Atlas) via Mongoose |
| Auth | JWT (bcrypt-hashed passwords) |
| Realtime | Socket.IO |
| External API | OneMap (Singapore Land Authority) — routing and static maps |
| Tests | Vitest (unit + HTTP) and Playwright (end-to-end) |

## Prerequisites

- **Node.js** `^22.18.0 || >=24.12.0`
- A **MongoDB** database. Atlas's free M0 tier is sufficient; a local `mongod` works too.
- A **OneMap** account for real walking times — optional. Register at
  <https://www.onemap.gov.sg/apidocs/register>. Without it the app still runs; Map layouts fall
  back to estimated walking times.

---

## Setup

```bash
git clone https://github.com/linusloke2025/wad2project
cd wad2project

# 1. Backend dependencies
cd server
npm install

# 2. Frontend dependencies
cd ../client
npm install
```

### Configure the backend

```bash
cd ../server
cp .env.example .env
```

Then edit `server/.env`. **`.env` is gitignored — never commit it.**

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | yes | Any long random string. Session tokens are signed with it. |
| `MONGODB_URI` | yes | Atlas connection string **including a database name**. |
| `PORT` | no | Defaults to `3000`. |
| `ONEMAP_EMAIL` / `ONEMAP_PASSWORD` | no | Enables real walking times and Map layouts. |
| `SEED_ROOT_EMAIL` / `SEED_ROOT_PASSWORD` | for seeding | The first root account, see below. |
| `SEED_COMMUNITY_NAME` | no | Defaults to `Default Community`. |

> **Include the database name in `MONGODB_URI`.** A URI ending at the host
> (`...mongodb.net?retryWrites=true`) silently writes to the shared `test` database rather than
> failing, which is easy to miss: use `...mongodb.net/yourdb?retryWrites=true`.

### Create the first account

There is **no public sign-up** — accounts are provisioned by an administrator — so the first root
account is created by a seed script. It is idempotent; running it twice is a no-op.

```bash
cd server
npm run seed
```

This creates the root account and its community. Everyone else is added afterwards, either by the
root/admin through **Add members in bulk** on the events page, or via `POST /api/members/import`.

---

## Running

### Development

Two processes, in two terminals:

```bash
# Terminal 1 — API on http://localhost:3000
cd server && npm run dev

# Terminal 2 — client on http://localhost:5173
cd client && npm run dev
```

Open <http://localhost:5173>. The dev server proxies `/api` and `/socket.io` to the API, so the
browser sees a single origin exactly as it will in production.

### Production-style, single origin

Express serves the built client, so there is one process and one origin:

```bash
cd client && npm run build     # emits client/dist
cd ../server && npm start      # serves the API and the built client
```

Open <http://localhost:3000>. The server logs which mode it is in and whether OneMap routing is
enabled.

---

## Testing

### Unit and HTTP tests (Vitest)

```bash
cd server
npm run test:unit
```

392 tests in total — one skips unless OneMap credentials are present in `server/.env`. They cover:

- **Domain logic**: the four conflict rules, polygon geometry, RBAC, password hashing, JWT
  handling, CSV parsing, announcement tallies, and the bottleneck report maths.
- **HTTP behaviour**: real requests against a freshly built Express app on an ephemeral port,
  asserting status codes and payloads — including that disallowed roles receive **403 from the
  server**, not merely that a button is hidden. Floor-plan upload is covered for its size cap,
  non-image rejection and byte-for-byte round trip.
- **Schema invariants**: Mongoose validation, checked without a database.
- **Realtime**: real Socket.IO clients, covering the handshake, room join and per-update
  authorisation.

Two things are worth knowing about the suite:

- **The OneMap live checks** (`tests/live/`) run only when `ONEMAP_EMAIL` and `ONEMAP_PASSWORD`
  are set, because they call the real OneMap API. Everything else uses fakes and needs no network.

### End-to-end tests (Playwright)

```bash
cd client
npm run build                     # the server serves the built client
npx playwright install chromium   # first time only
npx playwright test
```

41 tests across six journeys plus responsive checks. The suite is **self-contained**: Playwright
starts `server/src/scripts/serveForE2E.mjs`, which brings up an **embedded MongoDB**, seeds the
fixtures, and then starts the real server through the real entry point.

It therefore needs **no Atlas cluster, no `MONGODB_URI`, no IP allowlist and no network** — it runs
the same way on any machine and in CI. That is deliberate: a suite that depends on a cloud database
stops working whenever the network, the credentials or an allowlist changes, and this project lost
three rounds of verification to exactly that. The application still uses Atlas; only the tests are
independent, and the suite can no longer touch your data even by accident.

The first run downloads an `mongod` binary (roughly 100MB) into `.mongodb-binaries/`, which is
gitignored. It is a newer MongoDB release than a typical Atlas cluster, so the tests do not
exercise the exact production version.

`npm run build` must have been run at least once, or the suite will exercise a stale bundle.

| Journey | Covers |
|---|---|
| 1 · Authentication | sign-in, wrong password, unknown account, forced password change |
| 2 · Roles | what each role is and is not offered; bulk member import visibility |
| 3 · Layout | the designer's shapes reaching the plan |
| 4 · Scheduling | creating groups and scheduling movements |
| 5 · Conflicts | a double-booking flagged, and well-separated slots *not* flagged |
| 6 · Live tracking | a lead's update reaching a planner in a second browser session |
| Responsive | no horizontal overflow at **375px, 768px and 1200px** |

Playwright can also run by project, e.g. `npx playwright test --project=mobile-375`.

---

## Credentials for marking

These are development credentials, deliberately simple. **Change them before any real use.**

| Account | Password | Role |
|---|---|---|
| `root@example.com` | `SeedRootPass123` | root — created by `npm run seed` |

The end-to-end suite seeds its own accounts into the `-e2e` database (all with password
`E2ePassword123`), one per role: `e2e-root@`, `e2e-admin@`, `e2e-planner@`, `e2e-designer@`,
`e2e-lead@`, `e2e-member@`. The `e2e-temp@example.com` account (password `E2eTempPass123`) is
deliberately left on a temporary password so the forced-change flow can be demonstrated.

## Roles

Roles are **per-community membership**, so the same person can be a planner in one community and
an admin in another.

| | root | admin | designer | planner | user |
|---|---|---|---|---|---|
| Community settings | ✓ | | | | |
| Add / remove admins | ✓ | | | | |
| Manage users, bulk import | ✓ | ✓ *(not admins)* | | | |
| Create / delete events | ✓ | ✓ | | | |
| Edit an event | ✓ | ✓ | | ✓ | |
| Upload layout and zones | ✓ | ✓ | ✓ | | |
| Groups and itineraries | ✓ | ✓ | | ✓ | |
| View conflicts and the report | ✓ | ✓ | ✓ | ✓ | |
| Start / stop the event, broadcast | ✓ | ✓ | | ✓ | |
| Live board | ✓ | ✓ | ✓ | ✓ | own group |
| Report status / position | ✓ | ✓ | ✓ | ✓ | if group leader |

---

## Project structure

```
server/
  src/domain/        pure logic: conflicts, geometry, permissions, CSV, report
  src/services/      OneMap client, walk times, static maps, conflict service
  src/http/          Express routes and middleware
  src/realtime/      Socket.IO, live state, broadcaster
  src/models/        Mongoose schemas
  src/repositories/  Mongoose-backed data access
  tests/             unit, HTTP, realtime, live
client/
  src/views/         route-level screens
  src/components/    layout, scheduling, live board, report, member import
  src/stores/        Pinia session store
  e2e/               Playwright journeys
docs/SPEC.md         the requirements contract this was built against
```

## How the harder parts work

**Conflicts are advisory, never blocking.** A planner sees them inline and may proceed, because
organisers knowingly accept a tight transition. The unresolved count stays visible.

**Walk times are either routed or estimated, and never confused.** Map layouts use real OneMap
routes; floor plans estimate from a pixel-to-metre scale. Every conflict carries its source, and
the UI labels estimates as such. If OneMap fails, the estimate is used *and still labelled* — a
transient outage cannot freeze a guess in place as though it were measured.

**Live tracking degrades rather than failing.** GPS is unreliable indoors, so a group lead can
always report a status by hand. If the socket drops, the board reconnects and resyncs over HTTP
rather than assuming nothing was missed.

**Authorisation is enforced server-side.** Hiding a button is presentation; every route and every
socket update re-checks authority, and reporting authority is read from the stored group — a
client cannot claim to be a group leader.

## Deployment

The app is single-origin: Express serves both the API and the built client.

1. Build the client (`cd client && npm run build`).
2. Deploy `server/` to a host that provides **HTTPS** and **persistent connections** — Socket.IO
   needs a long-lived process, so a serverless platform is a poor fit.
3. Set the environment variables from `server/.env.example` in the host's dashboard.
4. Point `MONGODB_URI` at the Atlas cluster.

HTTPS is required, not optional: `navigator.geolocation` only works in a secure context, so
position sharing silently does nothing over plain HTTP.

The deployed URL and the video link go on the first slide of the submitted deck, as the brief
requires.

## Known limitations

- **Zones cannot be deleted from the UI.** A shape saved by mistake has to be removed through the
  API. The conflict engine already copes with an assignment whose zone has gone, so this is a
  missing control rather than a broken behaviour.
- **Zones are placed by tapping corners, with no editing afterwards.** There are no drag handles
  or undo; a wrong shape is cleared and redrawn.
- **A Plan layout is an image, not a geo-referenced map.** Its transitions are estimated from the
  pixel-to-metre scale rather than routed, which the UI labels as an estimate.
- **A group is created without a leader.** Leadership is assigned afterwards from the group's
  Members panel, and a group with no lead cannot report a status.
- **Track retention is not automated.** The spec sets a 30-day post-event deletion policy for
  location history; the schema supports the sweep but no job performs it yet.
- **Position history is not stored per ping** — only the latest position per group is kept in
  memory, plus the status history that the report reads.
- **OneMap rate limits are unverified.** Their documentation is JavaScript-rendered and returned
  no readable body, so no numeric limit could be confirmed. Route results are cached by zone pair.
