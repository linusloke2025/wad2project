import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'

import { createApp } from '../../src/app.js'
import { createTokenService } from '../../src/auth/tokens.js'
import { hashPassword } from '../../src/auth/passwords.js'
import { createConflictService } from '../../src/services/conflictService.js'
import { createLiveState } from '../../src/realtime/liveState.js'

// Listing an event's groups and assignments.
//
// The planning screen needs to show what exists before a planner can add to it, and the create
// endpoints alone are not enough — without a list the UI can only ever append blindly.
//
// Gated by conflict.view rather than being open: group composition and timings are planning
// data, so an ordinary member on the ground should not be able to read the whole schedule.

const oid = (n) => `64b7f0c2f1a2b3c4d5e6f7${String(n).padStart(2, '0')}`
const SECRET = 'test-secret-do-not-use-in-production'
const WINDOW = { start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T12:00:00+08:00' }

let httpServer
let baseUrl
let repositories

function makeRepositories() {
  const users = [
    { id: oid(1), email: 'planner@example.com', passwordHash: null, mustChangePassword: false },
    { id: oid(2), email: 'member@example.com', passwordHash: null, mustChangePassword: false },
  ]
  const memberships = [
    { userId: oid(1), communityId: 'c1', role: 'planner' },
    { userId: oid(2), communityId: 'c1', role: 'user' },
  ]

  const state = { events: [], groups: [], assignments: [], nextId: 1 }

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
        const event = { id: `e${state.nextId++}`, communityId, name, start, end, layoutMode: layoutMode ?? 'plan', createdBy }
        state.events.push(event)
        return event
      },
      async findById(eventId) { return state.events.find((e) => e.id === eventId) ?? null },
      async listByCommunity(communityId) { return state.events.filter((e) => e.communityId === communityId) },
    },
    zones: { async create() { return null }, async listByEvent() { return [] } },
    groups: {
      async create({ eventId, name, leadUserId }) {
        const group = { id: `g${state.nextId++}`, eventId, name, leadUserId: leadUserId ?? null }
        state.groups.push(group)
        return group
      },
      async findById(groupId) { return state.groups.find((g) => g.id === groupId) ?? null },
      async listByEvent(eventId) { return state.groups.filter((g) => g.eventId === eventId) },
    },
    assignments: {
      async create({ eventId, groupId, zoneId, start, end }) {
        const assignment = { id: `a${state.nextId++}`, eventId, groupId, zoneId, start, end }
        state.assignments.push(assignment)
        return assignment
      },
      async listByEvent(eventId) { return state.assignments.filter((a) => a.eventId === eventId) },
    },
    announcements: { async create() { return null }, async findById() { return null }, async listByEvent() { return [] } },
    announcementAcks: { async upsert() { return null }, async listByAnnouncement() { return [] } },
    _reset() { state.events = []; state.groups = []; state.assignments = []; state.nextId = 1 },
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
  for (const [email, plain] of Object.entries({ 'planner@example.com': 'plannerpass', 'member@example.com': 'memberpass' })) {
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

beforeEach(async () => {
  repositories._reset()
  await repositories.events.create({
    communityId: 'c1', name: 'Parade', ...WINDOW, layoutMode: 'plan', createdBy: oid(1),
  })
})

const EVENT = 'e1'

describe('GET /api/events/:eventId/groups', () => {
  it('lists the event groups with their lead', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')
    await repositories.groups.create({ eventId: EVENT, name: 'Group A', leadUserId: oid(2) })
    await repositories.groups.create({ eventId: EVENT, name: 'Group B', leadUserId: null })

    const { status, body } = await request(`/api/events/${EVENT}/groups`, { token })

    expect(status).toBe(200)
    expect(body.groups.map((g) => g.name).sort()).toEqual(['Group A', 'Group B'])
    expect(body.groups.find((g) => g.name === 'Group A').leadUserId).toBe(oid(2))
  })

  it('returns an empty list for an event with no groups', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const { status, body } = await request(`/api/events/${EVENT}/groups`, { token })

    expect(status).toBe(200)
    expect(body.groups).toEqual([])
  })

  it('refuses an ordinary member the schedule', async () => {
    const token = await sessionFor('member@example.com', 'memberpass')

    const { status } = await request(`/api/events/${EVENT}/groups`, { token })

    expect(status).toBe(403)
  })

  it('refuses an unauthenticated request', async () => {
    const { status } = await request(`/api/events/${EVENT}/groups`)

    expect(status).toBe(401)
  })

  it('returns 404 for an unknown event', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const { status } = await request('/api/events/nope/groups', { token })

    expect(status).toBe(404)
  })
})

describe('GET /api/events/:eventId/assignments', () => {
  it('lists the itinerary slots', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')
    await repositories.assignments.create({
      eventId: EVENT, groupId: 'g1', zoneId: 'z1', start: WINDOW.start, end: '2026-03-01T09:30:00+08:00',
    })

    const { status, body } = await request(`/api/events/${EVENT}/assignments`, { token })

    expect(status).toBe(200)
    expect(body.assignments).toHaveLength(1)
    expect(body.assignments[0]).toMatchObject({ groupId: 'g1', zoneId: 'z1' })
  })

  it('refuses an ordinary member', async () => {
    const token = await sessionFor('member@example.com', 'memberpass')

    const { status } = await request(`/api/events/${EVENT}/assignments`, { token })

    expect(status).toBe(403)
  })

  it('returns 404 for an event in another community', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')
    const foreign = await repositories.events.create({
      communityId: 'c-other', name: 'Theirs', ...WINDOW, layoutMode: 'plan', createdBy: oid(9),
    })

    const { status } = await request(`/api/events/${foreign.id}/assignments`, { token })

    expect(status).toBe(404)
  })
})
