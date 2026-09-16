import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'

import { createApp } from '../../src/app.js'
import { createTokenService } from '../../src/auth/tokens.js'
import { hashPassword } from '../../src/auth/passwords.js'
import { createConflictService } from '../../src/services/conflictService.js'
import { createLiveState } from '../../src/realtime/liveState.js'

// The post-event bottleneck report over HTTP.
//
// It reads persisted status history rather than live state, because the point of the report is
// to survive the event: live state is process memory and is gone after a restart, while the
// whole value of "where were the bottlenecks" is that somebody can look afterwards.

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

  const state = { events: [], zones: [], groups: [], assignments: [], statusUpdates: [], nextId: 1 }

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
    zones: {
      async create() { return null },
      async listByEvent(eventId) { return state.zones.filter((z) => z.eventId === eventId) },
    },
    groups: {
      async create() { return null },
      async findById() { return null },
      async listByEvent(eventId) { return state.groups.filter((g) => g.eventId === eventId) },
    },
    assignments: {
      async create() { return null },
      async listByEvent(eventId) { return state.assignments.filter((a) => a.eventId === eventId) },
    },
    statusUpdates: {
      async listByEvent(eventId) { return state.statusUpdates.filter((s) => s.eventId === eventId) },
      async create(fields) { state.statusUpdates.push(fields); return fields },
    },
    announcements: { async create() { return null }, async findById() { return null }, async listByEvent() { return [] } },
    announcementAcks: { async upsert() { return null }, async listByAnnouncement() { return [] } },
    _state: state,
    _reset() {
      state.events = []; state.zones = []; state.groups = []
      state.assignments = []; state.statusUpdates = []; state.nextId = 1
    },
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

const EVENT = 'e1'

beforeEach(async () => {
  repositories._reset()
  await repositories.events.create({ communityId: 'c1', name: 'Parade', ...WINDOW, layoutMode: 'plan', createdBy: oid(1) })
  repositories._state.zones.push({ id: 'z1', eventId: EVENT, name: 'Main Stage', kind: 'zone', polygon: [[0, 0], [10, 0], [10, 10]] })
  repositories._state.groups.push({ id: 'g1', eventId: EVENT, name: 'Group A', leadUserId: oid(2) })
})

describe('GET /api/events/:eventId/report', () => {
  it('compares actual dwell against the plan per zone', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')
    repositories._state.assignments.push({
      id: 'a1', eventId: EVENT, groupId: 'g1', zoneId: 'z1',
      start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T09:30:00+08:00',
    })
    repositories._state.statusUpdates.push(
      { eventId: EVENT, groupId: 'g1', status: 'arrived', at: '2026-03-01T09:05:00+08:00' },
      { eventId: EVENT, groupId: 'g1', status: 'moving', at: '2026-03-01T09:45:00+08:00' },
    )

    const { status, body } = await request(`/api/events/${EVENT}/report`, { token })

    expect(status).toBe(200)
    const zone = body.report.zones.find((entry) => entry.zoneId === 'z1')
    expect(zone.plannedDwellSeconds).toBe(30 * 60)
    // 09:05 to 09:45 is 40 minutes, ten more than planned.
    expect(zone.actualDwellSeconds).toBe(40 * 60)
    expect(zone.overrunSeconds).toBe(10 * 60)
  })

  it('marks a zone unmeasured when nobody reported there', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')
    repositories._state.assignments.push({
      id: 'a1', eventId: EVENT, groupId: 'g1', zoneId: 'z1',
      start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T09:30:00+08:00',
    })

    const { body } = await request(`/api/events/${EVENT}/report`, { token })

    const zone = body.report.zones.find((entry) => entry.zoneId === 'z1')
    expect(zone.measured).toBe(false)
    // Null rather than zero: zero would read as "the plan was met exactly".
    expect(zone.overrunSeconds).toBeNull()
  })

  it('includes zone overlap counts from the conflict engine', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')
    repositories._state.groups.push({ id: 'g2', eventId: EVENT, name: 'Group B', leadUserId: null })
    repositories._state.assignments.push(
      { id: 'a1', eventId: EVENT, groupId: 'g1', zoneId: 'z1', start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T10:00:00+08:00' },
      { id: 'a2', eventId: EVENT, groupId: 'g2', zoneId: 'z1', start: '2026-03-01T09:30:00+08:00', end: '2026-03-01T10:30:00+08:00' },
    )

    const { body } = await request(`/api/events/${EVENT}/report`, { token })

    expect(body.report.zones.find((entry) => entry.zoneId === 'z1').overlapCount).toBe(1)
  })

  it('refuses an ordinary member, since the report is planning analysis', async () => {
    const token = await sessionFor('member@example.com', 'memberpass')

    const { status } = await request(`/api/events/${EVENT}/report`, { token })

    expect(status).toBe(403)
  })

  it('refuses an unauthenticated request', async () => {
    const { status } = await request(`/api/events/${EVENT}/report`)

    expect(status).toBe(401)
  })

  it('returns 404 for an event in another community', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')
    const foreign = await repositories.events.create({
      communityId: 'c-other', name: 'Theirs', ...WINDOW, layoutMode: 'plan', createdBy: oid(9),
    })

    const { status } = await request(`/api/events/${foreign.id}/report`, { token })

    expect(status).toBe(404)
  })
})
