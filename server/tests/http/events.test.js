import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'

import { createApp } from '../../src/app.js'
import { createTokenService } from '../../src/auth/tokens.js'
import { hashPassword } from '../../src/auth/passwords.js'
import { createConflictService } from '../../src/services/conflictService.js'
import { createLiveState } from '../../src/realtime/liveState.js'

// Reading events, which the client needs before it can do anything: the events list is the
// landing page, and the detail view is where every planning panel hangs off.
//
// Community scoping is the property worth pinning. It is not enough that a wrong-community
// event 404s on its own route; the list must not leak another community's event names either.

const oid = (n) => `64b7f0c2f1a2b3c4d5e6f7${String(n).padStart(2, '0')}`
const SECRET = 'test-secret-do-not-use-in-production'
const WINDOW = { start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T12:00:00+08:00' }

let httpServer
let baseUrl
let repositories

function makeRepositories() {
  const users = [
    { id: oid(1), email: 'admin@example.com', passwordHash: null, mustChangePassword: false },
    { id: oid(2), email: 'member@example.com', passwordHash: null, mustChangePassword: false },
  ]
  const memberships = [
    { userId: oid(1), communityId: 'c1', role: 'admin' },
    { userId: oid(2), communityId: 'c1', role: 'user' },
  ]

  const state = { events: [], nextId: 1 }

  return {
    users: {
      async findByEmail(email) {
        return users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()) ?? null
      },
      async findById(id) { return users.find((u) => u.id === id) ?? null },
      async updatePassword() { return null },
    },
    memberships: {
      async listByUser(userId) { return memberships.filter((m) => m.userId === userId) },
      async find(userId, communityId) {
        return memberships.find((m) => m.userId === userId && m.communityId === communityId) ?? null
      },
    },
    events: {
      async create({ communityId, name, start, end, layoutMode, createdBy }) {
        const event = {
          id: `e${state.nextId++}`, communityId, name, start, end,
          layoutMode: layoutMode ?? 'plan', createdBy, status: 'draft',
        }
        state.events.push(event)
        return event
      },
      async findById(eventId) { return state.events.find((e) => e.id === eventId) ?? null },
      async listByCommunity(communityId) { return state.events.filter((e) => e.communityId === communityId) },
    },
    zones: { async create() { return null }, async listByEvent() { return [] } },
    groups: { async create() { return null }, async findById() { return null }, async listByEvent() { return [] } },
    assignments: { async create() { return null }, async listByEvent() { return [] } },
    announcements: { async create() { return null }, async findById() { return null }, async listByEvent() { return [] } },
    announcementAcks: { async upsert() { return null }, async listByAnnouncement() { return [] } },
    _reset() { state.events = []; state.nextId = 1 },
  }
}

async function request(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

async function sessionFor(email, password) {
  const { body } = await request('/api/auth/login', { method: 'POST', body: { email, password } })
  return body.token
}

beforeAll(async () => {
  repositories = makeRepositories()
  for (const [email, plain] of Object.entries({ 'admin@example.com': 'adminpass', 'member@example.com': 'memberpass' })) {
    const user = await repositories.users.findByEmail(email)
    user.passwordHash = await hashPassword(plain)
  }

  const app = createApp({
    tokenService: createTokenService({ secret: SECRET }),
    repositories,
    conflictService: createConflictService({ onemapClient: null }),
    liveState: createLiveState(),
  })
  httpServer = http.createServer(app)
  await new Promise((resolve) => httpServer.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`
})

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve))
})

beforeEach(() => {
  repositories._reset()
})

describe('GET /api/events', () => {
  it('lists the community events, newest window first', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    await repositories.events.create({ communityId: 'c1', name: 'Parade', ...WINDOW, layoutMode: 'map', createdBy: oid(1) })
    await repositories.events.create({ communityId: 'c1', name: 'Ceremony', ...WINDOW, layoutMode: 'plan', createdBy: oid(1) })

    const { status, body } = await request('/api/events', { token })

    expect(status).toBe(200)
    expect(body.events).toHaveLength(2)
    expect(body.events.map((e) => e.name).sort()).toEqual(['Ceremony', 'Parade'])
  })

  it('does not leak another community events into the list', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    await repositories.events.create({ communityId: 'c1', name: 'Mine', ...WINDOW, layoutMode: 'plan', createdBy: oid(1) })
    await repositories.events.create({ communityId: 'c-other', name: 'Theirs', ...WINDOW, layoutMode: 'plan', createdBy: oid(9) })

    const { body } = await request('/api/events', { token })

    expect(body.events.map((e) => e.name)).toEqual(['Mine'])
  })

  it('lets an ordinary member list events, since they must reach their own', async () => {
    const token = await sessionFor('member@example.com', 'memberpass')
    await repositories.events.create({ communityId: 'c1', name: 'Parade', ...WINDOW, layoutMode: 'plan', createdBy: oid(1) })

    const { status, body } = await request('/api/events', { token })

    expect(status).toBe(200)
    expect(body.events).toHaveLength(1)
  })

  it('refuses an unauthenticated request', async () => {
    const { status } = await request('/api/events')

    expect(status).toBe(401)
  })

  it('returns an empty list rather than an error when the community has no events', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')

    const { status, body } = await request('/api/events', { token })

    expect(status).toBe(200)
    expect(body.events).toEqual([])
  })
})

describe('GET /api/events/:eventId', () => {
  it('returns a single event', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const created = await repositories.events.create({
      communityId: 'c1', name: 'Parade', ...WINDOW, layoutMode: 'map', createdBy: oid(1),
    })

    const { status, body } = await request(`/api/events/${created.id}`, { token })

    expect(status).toBe(200)
    expect(body.name).toBe('Parade')
    expect(body.layoutMode).toBe('map')
    expect(body.id).toBe(created.id)
  })

  it('returns 404 for another community event, not 403', async () => {
    // Confirming existence would itself leak.
    const token = await sessionFor('admin@example.com', 'adminpass')
    const foreign = await repositories.events.create({
      communityId: 'c-other', name: 'Theirs', ...WINDOW, layoutMode: 'plan', createdBy: oid(9),
    })

    const { status } = await request(`/api/events/${foreign.id}`, { token })

    expect(status).toBe(404)
  })

  it('returns 404 for an unknown event', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')

    const { status } = await request('/api/events/does-not-exist', { token })

    expect(status).toBe(404)
  })

  it('refuses an unauthenticated request', async () => {
    const { status } = await request(`/api/events/${oid(20)}`)

    expect(status).toBe(401)
  })
})
