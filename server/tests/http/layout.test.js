import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

import { createApp } from '../../src/app.js'
import { createTokenService } from '../../src/auth/tokens.js'
import { hashPassword } from '../../src/auth/passwords.js'
import { createConflictService } from '../../src/services/conflictService.js'
import { createStaticMapService, PLACEHOLDER_MAP_IMAGE } from '../../src/services/staticMapService.js'

// The layout read path: what the planner actually looks at.
//
// For a Map-layout event this is the OneMap Static Map with the event's zones drawn on it. For
// a Plan-layout event it is the uploaded floor plan, so no map request is made at all.
//
// The static map service is the real one, wired to a controllable fetch, so these tests cover
// the genuine URL construction and degradation path rather than a stand-in.

const SECRET = 'test-secret-do-not-use-in-production'
const WINDOW = { start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T12:00:00+08:00' }

const ZONE = [[1.32000, 103.84000], [1.31000, 103.84000], [1.31000, 103.83000], [1.32000, 103.83000]]

let server
let baseUrl
let repositories
let staticMapFetch

const imageResponse = () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'image/png' },
  arrayBuffer: async () => new ArrayBuffer(1024),
})

function makeRepositories() {
  const users = [
    { id: 'u-admin', email: 'admin@example.com', passwordHash: null, mustChangePassword: false },
    { id: 'u-planner', email: 'planner@example.com', passwordHash: null, mustChangePassword: false },
    { id: 'u-user', email: 'user@example.com', passwordHash: null, mustChangePassword: false },
  ]
  const memberships = [
    { userId: 'u-admin', communityId: 'c1', role: 'admin' },
    { userId: 'u-planner', communityId: 'c1', role: 'planner' },
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
      async updatePassword() {
        return null
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
      async create({ communityId, name, start, end, layoutMode, latitude, longitude, metresPerPixel, createdBy }) {
        const event = {
          id: id('e'), communityId, name, start, end,
          layoutMode: layoutMode ?? 'plan',
          latitude: latitude ?? null,
          longitude: longitude ?? null,
          metresPerPixel: metresPerPixel ?? 1,
          createdBy, status: 'draft',
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
    },
    groups: { async listByEvent() { return [] }, async create() { return null } },
    assignments: { async listByEvent() { return [] }, async create() { return null } },
    _reset() {
      state.events = []; state.zones = []; state.groups = []; state.assignments = []; state.nextId = 1
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

async function sessionFor(email, password) {
  const { body } = await request('/api/auth/login', { method: 'POST', body: { email, password } })
  return body.token
}

async function createMapEvent(token, overrides = {}) {
  const { body } = await request('/api/events', {
    method: 'POST',
    body: { name: 'Parade', ...WINDOW, layoutMode: 'map', latitude: 1.31955, longitude: 103.84223, ...overrides },
    token,
  })
  return body.id
}

async function createPlanEvent(token) {
  const { body } = await request('/api/events', {
    method: 'POST',
    body: { name: 'Ceremony', ...WINDOW, layoutMode: 'plan', metresPerPixel: 0.1 },
    token,
  })
  return body.id
}

beforeAll(async () => {
  repositories = makeRepositories()
  for (const [email, plain] of Object.entries({
    'admin@example.com': 'adminpass',
    'planner@example.com': 'plannerpass',
    'user@example.com': 'userpass',
  })) {
    const user = await repositories.users.findByEmail(email)
    user.passwordHash = await hashPassword(plain)
  }

  staticMapFetch = async () => imageResponse()

  const app = createApp({
    tokenService: createTokenService({ secret: SECRET }),
    repositories,
    conflictService: createConflictService({ onemapClient: null }),
    staticMapService: createStaticMapService({ fetchImpl: (url) => staticMapFetch(url) }),
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
  staticMapFetch = async () => imageResponse()
})

describe('GET /api/events/:id/layout — Map layout', () => {
  it('returns a OneMap static map with the event zones drawn on it', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createMapEvent(token)
    await request(`/api/events/${eventId}/zones`, {
      method: 'POST',
      body: { name: 'Main Stage', polygon: ZONE },
      token,
    })

    const { status, body } = await request(`/api/events/${eventId}/layout`, { token })

    expect(status).toBe(200)
    expect(body.layoutMode).toBe('map')
    expect(body.imageUrl).toContain('/api/staticmap/getStaticImage')
    expect(body.imageUrl).toContain('latitude=1.31955')
    expect(body.warning).toBeNull()
    expect(body.omittedShapes).toBe(0)
  })

  it('still returns 200 with a placeholder and a warning when OneMap fails', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createMapEvent(token)
    staticMapFetch = async () => {
      throw new Error('OneMap down')
    }

    const { status, body } = await request(`/api/events/${eventId}/layout`, { token })

    // A map failure must never take down the planning view.
    expect(status).toBe(200)
    expect(body.imageUrl).toBe(PLACEHOLDER_MAP_IMAGE)
    expect(body.warning).toMatch(/unavailable/i)
  })

  it('reports how many shapes were left off the map', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createMapEvent(token)
    for (let i = 0; i < 23; i += 1) {
      await request(`/api/events/${eventId}/zones`, {
        method: 'POST',
        body: {
          name: `Zone ${i}`,
          polygon: [
            [1.32 + i * 0.0001, 103.84],
            [1.31 + i * 0.0001, 103.84],
            [1.31 + i * 0.0001, 103.83],
          ],
        },
        token,
      })
    }

    const { body } = await request(`/api/events/${eventId}/layout`, { token })

    expect(body.omittedShapes).toBe(3)
  })

  it('does not leak the OneMap URL parameters into a warning when successful', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createMapEvent(token)

    const { body } = await request(`/api/events/${eventId}/layout`, { token })

    expect(JSON.stringify(body)).not.toMatch(/password|access_token/i)
  })
})

describe('GET /api/events/:id/layout — Plan layout', () => {
  it('makes no map request and keeps the uploaded floor plan', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createPlanEvent(token)
    let called = false
    staticMapFetch = async () => {
      called = true
      return imageResponse()
    }

    const { status, body } = await request(`/api/events/${eventId}/layout`, { token })

    expect(status).toBe(200)
    expect(body.layoutMode).toBe('plan')
    // Pixel coordinates make a lat/lng map meaningless, so nothing is requested.
    expect(called).toBe(false)
    expect(body.imageUrl).toBeNull()
    expect(body.warning).toBeNull()
  })
})

describe('GET /api/events/:id/layout — access control', () => {
  it('refuses an unauthenticated request', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createMapEvent(token)

    const { status } = await request(`/api/events/${eventId}/layout`)

    expect(status).toBe(401)
  })

  it('lets a planner see the layout', async () => {
    const adminToken = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createMapEvent(adminToken)
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const { status } = await request(`/api/events/${eventId}/layout`, { token })

    expect(status).toBe(200)
  })

  it('refuses an ordinary user the planning view', async () => {
    const adminToken = await sessionFor('admin@example.com', 'adminpass')
    const eventId = await createMapEvent(adminToken)
    const token = await sessionFor('user@example.com', 'userpass')

    const { status } = await request(`/api/events/${eventId}/layout`, { token })

    expect(status).toBe(403)
  })

  it('returns 404 for an event in another community', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const foreign = await repositories.events.create({
      communityId: 'c-other', name: 'Foreign', ...WINDOW, layoutMode: 'map',
      latitude: 1.3, longitude: 103.8, createdBy: 'u-x',
    })

    const { status } = await request(`/api/events/${foreign.id}/layout`, { token })

    expect(status).toBe(404)
  })

  it('returns 404 for an unknown event', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')

    const { status } = await request('/api/events/nope/layout', { token })

    expect(status).toBe(404)
  })
})
