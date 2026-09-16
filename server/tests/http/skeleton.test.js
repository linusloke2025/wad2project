import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

import { createApp } from '../../src/app.js'
import { createTokenService } from '../../src/auth/tokens.js'
import { hashPassword } from '../../src/auth/passwords.js'
import { createConflictService } from '../../src/services/conflictService.js'

// The plan-first walking skeleton, end to end over real HTTP.
//
// This is the slice the spec committed to building first: log in, create an event, place zones,
// create groups, assign a group to a zone and time, and have the app flag the conflict. Every
// layer is real — Express routing, JSON parsing, the auth and capability middleware chain, the
// conflict engine, and the walk-time provider — with only MongoDB swapped for in-memory
// repositories.
//
// A plan-mode event is used so walk times are deterministic estimates and the test never
// touches the OneMap network.

const SECRET = 'test-secret-do-not-use-in-production'
const WINDOW = { start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T12:00:00+08:00' }

// Two zones 140 layout units apart. At 0.1 m/unit and 1.4 m/s that is a 10 second walk, which
// makes the tight-transition arithmetic checkable by hand.
const STAGE = [[0, 0], [10, 0], [10, 10], [0, 10]]
const HOLDING = [[0, 140], [10, 140], [10, 150], [0, 150]]

let server
let baseUrl
let repositories

function makeRepositories() {
  const users = [
    { id: 'u-admin', email: 'admin@example.com', passwordHash: null, mustChangePassword: false },
    { id: 'u-planner', email: 'planner@example.com', passwordHash: null, mustChangePassword: false },
    { id: 'u-designer', email: 'designer@example.com', passwordHash: null, mustChangePassword: false },
    { id: 'u-user', email: 'user@example.com', passwordHash: null, mustChangePassword: false },
  ]

  const memberships = [
    { userId: 'u-admin', communityId: 'c1', role: 'admin' },
    { userId: 'u-planner', communityId: 'c1', role: 'planner' },
    { userId: 'u-designer', communityId: 'c1', role: 'layout_designer' },
    { userId: 'u-user', communityId: 'c1', role: 'user' },
  ]

  const state = { events: [], zones: [], groups: [], assignments: [], nextId: 1 }
  const id = (prefix) => `${prefix}${state.nextId++}`

  return {
    users: {
      async findByEmail(email) {
        return users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()) ?? null
      },
      async findById(userId) {
        return users.find((u) => u.id === userId) ?? null
      },
      async updatePassword(userId, { passwordHash, mustChangePassword }) {
        const user = users.find((u) => u.id === userId)
        if (!user) return null
        Object.assign(user, { passwordHash, mustChangePassword })
        return user
      },
    },
    memberships: {
      async listByUser(userId) {
        return memberships.filter((m) => m.userId === userId)
      },
      async find(userId, communityId) {
        return memberships.find((m) => m.userId === userId && m.communityId === communityId) ?? null
      },
    },
    events: {
      async create({ communityId, name, start, end, layoutMode, metresPerPixel, createdBy }) {
        const event = {
          id: id('e'),
          communityId,
          name,
          start,
          end,
          layoutMode: layoutMode ?? 'plan',
          metresPerPixel: metresPerPixel ?? 1,
          createdBy,
          status: 'draft',
        }
        state.events.push(event)
        return event
      },
      async findById(eventId) {
        return state.events.find((e) => e.id === eventId) ?? null
      },
      async listByCommunity(communityId) {
        return state.events.filter((e) => e.communityId === communityId)
      },
    },
    zones: {
      async create({ eventId, name, kind, polygon }) {
        const zone = { id: id('z'), eventId, name, kind: kind ?? 'zone', polygon }
        state.zones.push(zone)
        return zone
      },
      async listByEvent(eventId) {
        return state.zones.filter((z) => z.eventId === eventId)
      },
      async deleteById(zoneId) {
        state.zones = state.zones.filter((z) => z.id !== zoneId)
      },
    },
    groups: {
      async create({ eventId, name, leadUserId }) {
        const group = { id: id('g'), eventId, name, leadUserId: leadUserId ?? null }
        state.groups.push(group)
        return group
      },
      async listByEvent(eventId) {
        return state.groups.filter((g) => g.eventId === eventId)
      },
    },
    assignments: {
      async create({ eventId, groupId, zoneId, start, end }) {
        const assignment = { id: id('a'), eventId, groupId, zoneId, start, end }
        state.assignments.push(assignment)
        return assignment
      },
      async listByEvent(eventId) {
        return state.assignments.filter((a) => a.eventId === eventId)
      },
    },
    // Test-only: reset per-event data between tests while keeping accounts.
    _reset() {
      state.events = []
      state.zones = []
      state.groups = []
      state.assignments = []
      state.nextId = 1
    },
  }
}

async function request(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

const login = (email, password) =>
  request('/api/auth/login', { method: 'POST', body: { email, password } })

async function sessionFor(email, password) {
  const { body } = await login(email, password)
  return body.token
}

/** Creates an event and returns its id, using the admin session. */
async function createEvent(token, overrides = {}) {
  const { body } = await request('/api/events', {
    method: 'POST',
    // metresPerPixel matters: without it the plan scale defaults to 1 m/unit and the
    // tight-transition arithmetic below would be 100s rather than the intended 10s. Setting it
    // here also proves the event's scale is plumbed through to the walk-time estimate.
    body: { name: 'National Day Parade', metresPerPixel: 0.1, ...WINDOW, ...overrides },
    token,
  })
  return body.id
}

beforeAll(async () => {
  repositories = makeRepositories()

  const passwords = {
    'admin@example.com': 'adminpass',
    'planner@example.com': 'plannerpass',
    'designer@example.com': 'designerpass',
    'user@example.com': 'userpass',
  }
  for (const [email, plain] of Object.entries(passwords)) {
    const user = await repositories.users.findByEmail(email)
    user.passwordHash = await hashPassword(plain)
  }

  const app = createApp({
    tokenService: createTokenService({ secret: SECRET }),
    repositories,
    // No OneMap client: plan-mode events estimate walk times deterministically.
    conflictService: createConflictService({ onemapClient: null }),
  })

  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
  repositories._reset()
})

describe('walking skeleton — login, event, zones, groups, assignments, conflicts', () => {
  it('flags a zone double-booking once two groups hold the same zone at overlapping times', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createEvent(token)

    const stage = await request(`/api/events/${eventId}/zones`, {
      method: 'POST',
      body: { name: 'Main Stage', polygon: STAGE },
      token,
    })
    expect(stage.status).toBe(201)

    const a = await request(`/api/events/${eventId}/groups`, {
      method: 'POST',
      body: { name: 'Group A' },
      token,
    })
    const b = await request(`/api/events/${eventId}/groups`, {
      method: 'POST',
      body: { name: 'Group B' },
      token,
    })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)

    // Both groups hold the Main Stage at overlapping times: 09:00-10:00 and 09:30-10:30.
    await request(`/api/events/${eventId}/assignments`, {
      method: 'POST',
      body: { groupId: a.body.id, zoneId: stage.body.id, start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T10:00:00+08:00' },
      token,
    })
    await request(`/api/events/${eventId}/assignments`, {
      method: 'POST',
      body: { groupId: b.body.id, zoneId: stage.body.id, start: '2026-03-01T09:30:00+08:00', end: '2026-03-01T10:30:00+08:00' },
      token,
    })

    const { status, body } = await request(`/api/events/${eventId}/conflicts`, { token })

    expect(status).toBe(200)
    expect(body.conflicts).toHaveLength(1)
    expect(body.conflicts[0].type).toBe('zone_double_booking')
    expect(body.conflicts[0].zoneId).toBe(stage.body.id)
    // The count is what the planner's UI badges, so it must be exposed directly.
    expect(body.unresolvedCount).toBe(1)
  })

  it('reports no conflicts for a clean plan', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createEvent(token)

    const stage = await request(`/api/events/${eventId}/zones`, {
      method: 'POST',
      body: { name: 'Main Stage', polygon: STAGE },
      token,
    })
    const holding = await request(`/api/events/${eventId}/zones`, {
      method: 'POST',
      body: { name: 'Holding Area', polygon: HOLDING },
      token,
    })
    const a = await request(`/api/events/${eventId}/groups`, { method: 'POST', body: { name: 'Group A' }, token })
    const b = await request(`/api/events/${eventId}/groups`, { method: 'POST', body: { name: 'Group B' }, token })

    // Sequential, non-overlapping, generously spaced.
    await request(`/api/events/${eventId}/assignments`, {
      method: 'POST',
      body: { groupId: a.body.id, zoneId: holding.body.id, start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T09:30:00+08:00' },
      token,
    })
    await request(`/api/events/${eventId}/assignments`, {
      method: 'POST',
      body: { groupId: a.body.id, zoneId: stage.body.id, start: '2026-03-01T10:00:00+08:00', end: '2026-03-01T10:30:00+08:00' },
      token,
    })
    await request(`/api/events/${eventId}/assignments`, {
      method: 'POST',
      body: { groupId: b.body.id, zoneId: stage.body.id, start: '2026-03-01T11:00:00+08:00', end: '2026-03-01T11:30:00+08:00' },
      token,
    })

    const { body } = await request(`/api/events/${eventId}/conflicts`, { token })

    expect(body.conflicts).toEqual([])
    expect(body.unresolvedCount).toBe(0)
  })

  it('flags a tight transition using the estimated walk time, labelled as an estimate', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createEvent(token)

    const stage = await request(`/api/events/${eventId}/zones`, { method: 'POST', body: { name: 'Main Stage', polygon: STAGE }, token })
    const holding = await request(`/api/events/${eventId}/zones`, { method: 'POST', body: { name: 'Holding Area', polygon: HOLDING }, token })
    const a = await request(`/api/events/${eventId}/groups`, { method: 'POST', body: { name: 'Group A' }, token })

    // 140 units apart at 0.1 m/unit and 1.4 m/s is a 10 second walk; give it only 5 seconds.
    await request(`/api/events/${eventId}/assignments`, {
      method: 'POST',
      body: { groupId: a.body.id, zoneId: stage.body.id, start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T09:10:00+08:00' },
      token,
    })
    await request(`/api/events/${eventId}/assignments`, {
      method: 'POST',
      body: { groupId: a.body.id, zoneId: holding.body.id, start: '2026-03-01T09:10:05+08:00', end: '2026-03-01T09:20:00+08:00' },
      token,
    })

    const { body } = await request(`/api/events/${eventId}/conflicts`, { token })
    const tight = body.conflicts.find((c) => c.type === 'tight_transition')

    expect(tight).toBeDefined()
    expect(tight.gapSeconds).toBe(5)
    expect(tight.walkSeconds).toBeCloseTo(10, 5)
    // Acceptance criterion 5: an estimate must never be presented as a real route.
    expect(tight.source).toBe('estimate')
  })

  it('flags a group with no assignment during the event window', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createEvent(token)

    const stage = await request(`/api/events/${eventId}/zones`, { method: 'POST', body: { name: 'Main Stage', polygon: STAGE }, token })
    const a = await request(`/api/events/${eventId}/groups`, { method: 'POST', body: { name: 'Group A' }, token })
    await request(`/api/events/${eventId}/groups`, { method: 'POST', body: { name: 'Forgotten Group' }, token })

    await request(`/api/events/${eventId}/assignments`, {
      method: 'POST',
      body: { groupId: a.body.id, zoneId: stage.body.id, start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T09:30:00+08:00' },
      token,
    })

    const { body } = await request(`/api/events/${eventId}/conflicts`, { token })

    expect(body.conflicts).toHaveLength(1)
    expect(body.conflicts[0].type).toBe('unscheduled_group')
  })

  it('flags an assignment whose zone overlaps an area the designer marked blocked', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createEvent(token)

    const stage = await request(`/api/events/${eventId}/zones`, { method: 'POST', body: { name: 'Main Stage', polygon: STAGE }, token })
    // Overlaps STAGE deliberately.
    await request(`/api/events/${eventId}/zones`, {
      method: 'POST',
      body: { name: 'Closed for works', kind: 'blocked', polygon: [[5, 5], [15, 5], [15, 15], [5, 15]] },
      token,
    })
    const a = await request(`/api/events/${eventId}/groups`, { method: 'POST', body: { name: 'Group A' }, token })

    await request(`/api/events/${eventId}/assignments`, {
      method: 'POST',
      body: { groupId: a.body.id, zoneId: stage.body.id, start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T09:30:00+08:00' },
      token,
    })

    const { body } = await request(`/api/events/${eventId}/conflicts`, { token })

    expect(body.conflicts).toHaveLength(1)
    expect(body.conflicts[0].type).toBe('blocked_area')
    expect(body.conflicts[0].kind).toBe('occupied')
  })
})

describe('walking skeleton — capability enforcement on the new routes', () => {
  it('lets a layout designer place zones', async () => {
    const token = await sessionFor('designer@example.com', 'designerpass')
    // A designer cannot create the event, so the admin makes it first.
    const adminToken = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createEvent(adminToken)

    const { status } = await request(`/api/events/${eventId}/zones`, {
      method: 'POST',
      body: { name: 'Stage', polygon: STAGE },
      token,
    })

    expect(status).toBe(201)
  })

  it('refuses a layout designer creating a group', async () => {
    const adminToken = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createEvent(adminToken)
    const token = await sessionFor('designer@example.com', 'designerpass')

    const { status } = await request(`/api/events/${eventId}/groups`, {
      method: 'POST',
      body: { name: 'Group A' },
      token,
    })

    expect(status).toBe(403)
  })

  it('lets a planner create groups and assignments but not the event', async () => {
    const adminToken = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createEvent(adminToken)
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const created = await request(`/api/events`, { method: 'POST', body: { name: 'Nope', ...WINDOW }, token })
    expect(created.status).toBe(403)

    const group = await request(`/api/events/${eventId}/groups`, { method: 'POST', body: { name: 'Group A' }, token })
    expect(group.status).toBe(201)
  })

  it('refuses an ordinary user viewing the conflict list', async () => {
    const adminToken = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createEvent(adminToken)
    const token = await sessionFor('user@example.com', 'userpass')

    const { status } = await request(`/api/events/${eventId}/conflicts`, { token })

    expect(status).toBe(403)
  })
})

describe('walking skeleton — validation and scoping', () => {
  it('returns 404 for an event that does not exist', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')

    const { status } = await request('/api/events/does-not-exist/conflicts', { token })

    expect(status).toBe(404)
  })

  it('rejects a zone polygon with fewer than three points', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createEvent(token)

    const { status } = await request(`/api/events/${eventId}/zones`, {
      method: 'POST',
      body: { name: 'Degenerate', polygon: [[0, 0], [1, 1]] },
      token,
    })

    expect(status).toBe(400)
  })

  it('rejects an assignment that ends before it starts', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createEvent(token)
    const zone = await request(`/api/events/${eventId}/zones`, { method: 'POST', body: { name: 'Stage', polygon: STAGE }, token })
    const group = await request(`/api/events/${eventId}/groups`, { method: 'POST', body: { name: 'Group A' }, token })

    const { status } = await request(`/api/events/${eventId}/assignments`, {
      method: 'POST',
      body: { groupId: group.body.id, zoneId: zone.body.id, start: '2026-03-01T10:00:00+08:00', end: '2026-03-01T09:00:00+08:00' },
      token,
    })

    expect(status).toBe(400)
  })

  it('refuses to read an event belonging to another community', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    // Seeded directly into the store with a different community, as if another tenant's event.
    const foreign = await repositories.events.create({
      communityId: 'c-other',
      name: 'Other tenant event',
      ...WINDOW,
      createdBy: 'u-someone',
    })

    const { status } = await request(`/api/events/${foreign.id}/conflicts`, { token })

    // 404 rather than 403: confirming the event exists would leak another tenant's data.
    expect(status).toBe(404)
  })

  it('still reports conflicts when an assignment references a zone that was deleted', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createEvent(token)

    const stage = await request(`/api/events/${eventId}/zones`, {
      method: 'POST',
      body: { name: 'Main Stage', polygon: STAGE },
      token,
    })
    const holding = await request(`/api/events/${eventId}/zones`, {
      method: 'POST',
      body: { name: 'Holding Area', polygon: HOLDING },
      token,
    })
    const group = await request(`/api/events/${eventId}/groups`, {
      method: 'POST',
      body: { name: 'Group A' },
      token,
    })

    // Two assignments, so the transition rule genuinely has to compute a walk time between
    // them — that is the path that reaches for the missing zone's centroid.
    await request(`/api/events/${eventId}/assignments`, {
      method: 'POST',
      body: {
        groupId: group.body.id,
        zoneId: stage.body.id,
        start: '2026-03-01T09:00:00+08:00',
        end: '2026-03-01T09:10:00+08:00',
      },
      token,
    })
    await request(`/api/events/${eventId}/assignments`, {
      method: 'POST',
      body: {
        groupId: group.body.id,
        zoneId: holding.body.id,
        start: '2026-03-01T09:30:00+08:00',
        end: '2026-03-01T09:40:00+08:00',
      },
      token,
    })

    // A designer removes the zone while the itinerary still points at it. This must not take
    // the whole conflict list down — the planner still needs to see every other problem.
    await repositories.zones.deleteById(holding.body.id)

    const { status, body } = await request(`/api/events/${eventId}/conflicts`, { token })

    expect(status).toBe(200)
    expect(Array.isArray(body.conflicts)).toBe(true)
  })
})
