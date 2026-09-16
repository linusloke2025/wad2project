# IS216 Group Project — Engineering Spec

**Project:** Event coordination web app for large events (parades, ceremonies)
**Course:** IS216 Web Application Development 2 — Group Project, 2026-2027 Term 1
**Team size:** 6
**Status:** Contract recorded. Implementation not started.

Source of grading requirements: `Brief.pdf` in the repo root (decoded in full; see
`docs/brief-decoded.txt` for the extracted text, which is the authoritative summary of the brief).

---

## 1. Problem statement

Large events — parades, ceremonies, processions — involve many moving groups. Coordination
today happens over Telegram, which is messy: there is no single source of truth for who moves
where and when, no easy way to spot bottlenecks, and no reliable way to know when to move.

Bottlenecks are also invisible *after* the fact, so organisers cannot learn from an event.

**The app replaces coordination uncertainty — not chat.**

## 2. Goal

A responsive, mobile-first Vue 3 + Node/Express + MongoDB web app that coordinates large
events: organisers plan group movements across Map or Plan layouts, the app auto-flags
timing/zone/blocked-area conflicts using OneMap walking times, group leads are tracked live
(GPS with manual fallback), announcements carry acknowledgement receipts, and a post-event
bottleneck report is produced — satisfying the IS216 minimum requirements.

## 3. Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | Vue 3 + Vite + Composition API + Pinia + Vue Router | Matches IS216 templates and the final exam |
| Styling | Bootstrap 5.3 | Course-encouraged; breakpoints drive the responsive criteria |
| Language | Plain JavaScript, ES modules | Matches course templates (`jsconfig.json`) and the exam |
| Backend | Node + Express | Suggested by the brief (IS113 lineage) |
| Database | MongoDB Atlas (M0 free tier) | No local mongod installed; deployment needs a cloud DB |
| Images | MongoDB GridFS | Survives redeploys; no third-party account |
| Auth | JWT, passwords hashed | Full auth per team decision |
| Realtime | Socket.IO | Live board, GPS ingestion, announcements |
| External API | **OneMap (Singapore SLA)** | Token auth + routing gives real walking times that drive the conflict engine |
| Testing | Vitest (unit) + Playwright (E2E) | Ships with the course templates; rubric rewards stable selectors |
| Hosting | One always-on host, single origin | HTTPS required for geolocation; WebSockets need a persistent process |

## 4. Roles and permissions

Roles are **per-community membership** — the same user may be a planner in one community and
an admin in another. The UI switches between communities, then between events inside the
active community, without re-login.

| Capability | root | admin | designer | planner | user |
|---|---|---|---|---|---|
| Community settings | yes | – | – | – | – |
| Add/remove **admins** | yes | – | – | – | – |
| Manage users & roles | yes | yes *(not admins)* | – | – | – |
| Mass-add users (CSV) | yes | yes | – | – | – |
| **Create / delete events** | yes | yes | – | – | – |
| **Edit events** | yes | yes | – | yes | – |
| Upload layout + zones | yes | yes | yes | – | – |
| Groups + zone/time itineraries | yes | yes | – | yes | – |
| View conflict warnings | yes | yes | yes | yes | – |
| Start / stop live event | yes | yes | – | yes | – |
| View live board | yes | yes | yes | yes | own group |
| Report status / GPS | yes | yes | yes | yes | if group lead |
| Post-event bottleneck report | yes | yes | yes | yes | – |

**Group lead** is a per-group flag on a member, not a sixth role. Reporting rights follow the
assignment, so a lead can report only for their own group.

The rule *"admins can control users but not other admins"* is the privilege-escalation boundary
and must have an explicit test.

## 5. Domain model

- **Community** — tenant. Owns events and memberships.
- **Membership** — (user, community, role). Enables per-community roles.
- **Event** — belongs to a community. Lifecycle: draft → **live** → ended. Live board and GPS
  operate only while live.
- **Layout** — one of two modes:
  - **Map layout** — zones drawn on the real OneMap basemap, so true lat/long → real routing.
  - **Plan layout** — uploaded floor-plan image, zones in pixel coordinates plus a
    **pixel-to-metre scale**, so transitions are scaled straight-line estimates.
- **Zone** — polygon on the layout, with type (stage, holding area, walkway, …).
- **Obstacle / Stair / Lift / Blocked area** — polygons or markers placed by the designer.
- **Group** — a moving unit within an event. Created by a **planner**, who assigns its members
  and designates one of them as lead.
- **Assignment** — a group's **sequential itinerary**: ordered (zone, time window) slots.
- **StatusUpdate** — pending / moving / arrived / delayed, from a lead.
- **PositionPing** — throttled GPS from a group lead, stored at group level. Retained until
  **30 days after the event ends**, then deleted.
- **Announcement** — one-way broadcast + fixed acknowledgement enum
  (`acknowledged` / `need help` / `can't comply`). **No free-text field.**
- **Conflict** — computed, never stored as truth: see section 6.

### 5.1 Account lifecycle

Accounts are **admin-created only** — there is no public sign-up. Mass-add via CSV gives each
account an **admin-supplied temporary password**, and the user **must change it on first
login**. The seeded root creates the first community.

## 6. Conflict engine (the graded core)

Four rules, all computed from the plan:

1. **Zone double-booking** — two groups hold the same zone with overlapping time windows.
2. **Tight transition** — between consecutive itinerary slots, the gap is shorter than the
   walking time between them. In Map layout mode this uses **OneMap routing**; in Plan layout
   mode it uses pixel-distance × scale ÷ walking speed, **labelled as an estimate**.
3. **Blocked-area violation** — an assignment places a group inside, or routes it through, a
   polygon marked blocked.
4. **Unscheduled group** — a group has no assignment during the event window.

**Behaviour:** conflicts are **advisory warnings, never blocking**. The planner sees them inline
on the timeline and may proceed, with a visible **unresolved-conflict count** on the event. This
is deliberate — organisers knowingly accept tight transitions, and making the accepted risk
visible is more useful than forbidding it.

**Timing:** conflicts are computed **live on every assignment create/edit**, with route results
**cached by zone pair** so OneMap is never called per keystroke.

## 7. Post-event bottleneck report

Per zone: **actual dwell time vs planned**, **overlap count**, and **flagged tight transitions
with their walk times**. This is the direct answer to "no way to find out where the bottlenecks
are easily".

## 8. Acceptance criteria

1. `npm run test:unit` passes, covering all 4 conflict rules and the RBAC matrix, including an
   explicit **admin-cannot-modify-admin** test.
2. `npx playwright test` passes **6 module E2E journeys** from a clean clone.
3. Every disallowed role action returns **403 from the server** — no client-only gating.
4. The conflict engine flags all four conflict types.
5. Map layout returns real OneMap walk times; Plan layout returns scaled estimates labelled as
   estimates.
6. The live board reflects a group-lead status/GPS update in a **second browser context**
   within ~10-15s.
7. Announcements show a per-group acknowledgement tally with an unacknowledged flag, and **no
   free-text field exists**.
8. No horizontal overflow, usable at **375px, 768px, 1200px** in Chrome.
9. **OneMap logo and attribution** visible wherever the basemap renders (required by OneMap's
   Terms of Use).
10. README documents setup, run, test steps and seed credentials; repository is public.

## 9. Failure modes

| Failure | Required behaviour |
|---|---|
| OneMap token expired | Refresh using `expiry_timestamp`; if refresh fails, serve cached routes and label as estimated; never crash |
| OneMap unreachable / rate-limited | Cached route results, else distance estimate with a visible label |
| GPS denied, unavailable, or indoors | Automatic fallback to manual status; live board stays functional |
| WebSocket drop | Client reconnects and resyncs over HTTP; no lost state, no duplicates |
| Invalid CSV row | Per-row error report; valid rows imported; no partial corruption |
| Oversized / non-image upload | Rejected with a clear message; downscaled and compressed before GridFS |
| Duplicate email on mass-add | Row skipped with a stated reason |
| Expired JWT | Redirect to login; no data leak |
| Concurrent edit of one assignment | Documented last-write-wins |
| Atlas storage near quota | Upload rejected with a clear message, not a silent failure |

## 10. Priorities and cut order

**Depth over breadth.** Protect in order:

1. Working app + core conflict logic
2. Live tracking
3. Responsive UI
4. E2E tests

Cut in order: CSV polish → extra marker types → polygon editing niceties.

Live tracking is explicitly protected because the team values it most.

## 11. Non-goals

- No in-app chat, replies or DMs. Announcements are one-way with a fixed enum and no free text.
- No continuous GPS of all participants — group leads only, during the live window only.
- No native mobile app. No payments or ticketing.
- No email, SMS or push notifications.
- No offline mode or PWA. No AI features.
- No self-hosted map tiles. No zone capacity limits.
- No drag/resize polygon handles. No public self-registration.

## 12. Job scopes (6 members)

Each member owns one module **including its Vitest units, its Playwright E2E spec, and its
375px mobile behaviour**.

| # | Module | Owns |
|---|---|---|
| 1 | Auth & Identity | Register/login, JWT issue + verify, password hashing, route guards, seed script for first root |
| 2 | Community, Membership & RBAC | Community/Event/Membership models, permission middleware, privilege-escalation tests, CSV mass-add |
| 3 | Layout Designer | Image upload + downscale, GridFS, polygon authoring (tap vertices, double-click), zones/obstacles/stairs/lifts/blocked, OneMap basemap + attribution |
| 4 | Planning & Scheduling | Groups, sequential zone/time itineraries, timeline UI, assignment CRUD |
| 5 | Conflict Engine & OneMap | The 4 conflict rules, OneMap token cache/refresh, route-time lookup + caching, conflict display, bottleneck report |
| 6 | Live Tracking & Realtime | Socket.IO + handshake auth, throttled GPS ingestion, manual status fallback, live board, announcements + acknowledgement reactions, reconnect/resync |

Testing is distributed deliberately: the rubric grades testing (10%) and requires all members to
code, so a single "test person" would both overload one member and weaken everyone else's
individual Q&A defence.

## 13. Key risks

| Risk | Mitigation |
|---|---|
| **Polygon authoring on a 375px screen** is awkward UX and styling is 18% of the mark | Verify at 375px early; shapes render read-only on mobile if authoring proves unusable there |
| Free hosting tier sleeps → dropped sockets during grading | Use one always-on host; client reconnects and resyncs over HTTP regardless |
| Atlas M0 storage quota unverified; GridFS images share it | Downscale/compress uploads; reject oversized files with a clear message |
| OneMap rate limits unverified (docs are JS-rendered) | Cache route results by zone pair; confirm limits at setup |
| 6 members × 5 roles × realtime + GPS is a large surface for one term | Follow the cut order in section 10; protect the conflict engine first |

## 14. Open items

Settled: conflict severity (advisory), conflict timing (live with cached routes), group
creation and lead designation (planner), first-password flow (temp + forced change), track
retention (30 days post-event).

Verified against the **live** OneMap API (round 6, with real credentials):

- **Auth**: `POST /api/auth/post/getToken` with `{email, password}` returns `access_token` plus
  `expiry_timestamp`, which is epoch **seconds**. Observed token lifetime: **72.0 hours**.
- **Routing**: `GET /api/public/routingsvc/route?start=lat,lng&end=lat,lng&routeType=walk` with the
  raw token in the **`Authorization` header** (no `Bearer` prefix). The `token` query param returns
  401. Response carries `route_summary.total_time` (**seconds**) and `.total_distance` (**metres**).
- **Static Map**: `GET /api/staticmap/getStaticImage` needs **no authentication** at all. Polygons
  are **pipe**-separated with a **colon** before the colour (the docs prose says semicolon and is
  wrong), and the ring must be closed. Some failures return **HTTP 200 with a JSON body**, so the
  content type — not `response.ok` — is the success signal.

Guarded by an opt-in live test at `server/tests/live/onemap.live.test.js`, which skips when
credentials are absent so a fresh clone and CI stay green.

Still unknown — neither blocking:

- OneMap documented **rate limits** (their docs pages are JS-rendered; no numeric limit confirmed).
  Route results are cached by zone pair upstream, which keeps call volume off the keystroke path.
- MongoDB Atlas M0 exact storage quota.
