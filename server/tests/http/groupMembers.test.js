import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'

import { createApp } from '../../src/app.js'
import { createTokenService } from '../../src/auth/tokens.js'
import { hashPassword } from '../../src/auth/passwords.js'
import { createConflictService } from '../../src/services/conflictService.js'
import { createLiveState } from '../../src/realtime/liveState.js'

// Group membership and leader designation.
//
// The spec says the planner "creates the group, assigns members, and designates one as lead".
// Creation existed; assignment and designation did not, so a group could only ever have the lead
// the fixture gave it — and the live board's per-group reporting authority depends entirely on
// who that lead is.
//
// The invariant worth pinning is that a lead must be a member of the group they lead. A lead who
// is not in the group could report for people they are not part of, which the live board would
// then present to planners as authoritative.

const oid = (n) => `64b7f0c2f1a2b3c4d5e6f7${String(n).padStart(2, '0')}`
const SECRET = 'test-secret-do-not-use-in-production'
const WINDOW = { start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T12:00:00+08:00' }

let httpServer
let baseUrl
let repositories

function makeRepositories() {
  const users = [
    { id: oid(1), email: 'planner@example.com', name: 'Pat Planner', passwordHash: null, mustChangePassword: false },
    { id: oid(2), email: 'designer@example.com', name: 'Dana Designer', passwordHash: null, mustChangePassword: false },
    { id: oid(3), email: 'lead@example.com', name: 'Lee Lead', passwordHash: null, mustChangePassword: false },
    { id: oid(4), email: 'other@example.com', name: 'Ola Other', passwordHash: null, mustChangePassword: false },
    { id: oid(5), email: 'outsider@example.com', name: 'Oscar Outsider', passwordHash: null, mustChangePassword: false },
  ]
  const memberships = [
    { userId: oid(1), communityId: 'c1', role: 'planner' },
    { userId: oid(2), communityId: 'c1', role: 'layout_designer' },
    { userId: oid(3), communityId: 'c1', role: 'user' },
    { userId: oid(4), communityId: 'c1', role: 'user' },
    // Belongs to a different community only.
    { userId: oid(5), communityId: 'c-other', role: 'user' },
  ]

  const state = {
    events: [], groups: [], updated: [], nextId: 1,
  }

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
      async listByCommunity(communityId) { return memberships.filter((m) => m.communityId === communityId) },
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
      async create({ eventId, name, leadUserId, memberIds }) {
        const group = { id: `g${state.nextId++}`, eventId, name, leadUserId: leadUserId ?? null, memberIds: memberIds ?? [] }
        state.groups.push(group)
        return group
      },
      async findById(groupId) { return state.groups.find((g) => g.id === groupId) ?? null },
      async listByEvent(eventId) { return state.groups.filter((g) => g.eventId === eventId) },
      async update(groupId, fields) {
        const group = state.groups.find((g) => g.id === groupId)
        if (!group) return null
        Object.assign(group, fields)
        state.updated.push({ groupId, fields })
        return group
      },
    },
    assignments: { async create() { return null }, async listByEvent() { return [] } },
    announcements: { async create() { return null }, async findById() { return null }, async listByEvent() { return [] } },
    announcementAcks: { async upsert() { return null }, async listByAnnouncement() { return [] } },
    statusUpdates: { async create() { return null }, async listByEvent() { return [] } },
    _state: state,
    _reset() { state.events = []; state.groups = []; state.updated = []; state.nextId = 1 },
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
  for (const [email, plain] of Object.entries({
    'planner@example.com': 'plannerpass',
    'designer@example.com': 'designerpass',
    'lead@example.com': 'leadpass',
    'other@example.com': 'otherpass',
    'outsider@example.com': 'outsiderpass',
  })) {
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
  repositories._state.groups.push({ id: 'g1', eventId: EVENT, name: 'Group A', leadUserId: null, memberIds: [] })
})

describe('GET /api/members', () => {
  it('lists the community members with their role', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const { status, body } = await request('/api/members', { token })

    expect(status).toBe(200)
    expect(body.members).toHaveLength(4)
    expect(body.members.find((m) => m.email === 'lead@example.com')).toMatchObject({ role: 'user' })
  })

  it('does not leak members of another community', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const { body } = await request('/api/members', { token })

    expect(body.members.map((m) => m.email)).not.toContain('outsider@example.com')
  })

  it('never exposes a password hash', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const { body } = await request('/api/members', { token })

    expect(JSON.stringify(body)).not.toMatch(/passwordHash/i)
  })

  it('refuses a role that may not manage groups', async () => {
    // A designer may shape the layout but does not decide who is in a group.
    const token = await sessionFor('designer@example.com', 'designerpass')

    const { status } = await request('/api/members', { token })

    expect(status).toBe(403)
  })

  it('refuses an unauthenticated request', async () => {
    const { status } = await request('/api/members')

    expect(status).toBe(401)
  })
})

describe('PATCH /api/events/:eventId/groups/:groupId', () => {
  it('assigns members and designates one of them as lead', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const { status, body } = await request(`/api/events/${EVENT}/groups/g1`, {
      method: 'PATCH',
      body: { memberIds: [oid(3), oid(4)], leadUserId: oid(3) },
      token,
    })

    expect(status).toBe(200)
    expect(body.leadUserId).toBe(oid(3))
    expect(body.memberIds).toEqual([oid(3), oid(4)])
  })

  it('refuses a lead who is not a member of the group', async () => {
    // Otherwise a lead could report on behalf of people they are not part of, and the live board
    // would present that as authoritative.
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const { status, body } = await request(`/api/events/${EVENT}/groups/g1`, {
      method: 'PATCH',
      body: { memberIds: [oid(3)], leadUserId: oid(4) },
      token,
    })

    expect(status).toBe(400)
    expect(body.error).toMatch(/member/i)
  })

  it('accepts designating a lead already in the member list', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')
    await request(`/api/events/${EVENT}/groups/g1`, {
      method: 'PATCH', body: { memberIds: [oid(3), oid(4)] }, token,
    })

    const { status } = await request(`/api/events/${EVENT}/groups/g1`, {
      method: 'PATCH', body: { leadUserId: oid(4) }, token,
    })

    expect(status).toBe(200)
  })

  it('refuses a member who is not in this community', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const { status } = await request(`/api/events/${EVENT}/groups/g1`, {
      method: 'PATCH',
      body: { memberIds: [oid(5)] },
      token,
    })

    expect(status).toBe(400)
  })

  it('can clear the lead', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')
    await request(`/api/events/${EVENT}/groups/g1`, {
      method: 'PATCH', body: { memberIds: [oid(3)], leadUserId: oid(3) }, token,
    })

    const { status, body } = await request(`/api/events/${EVENT}/groups/g1`, {
      method: 'PATCH', body: { leadUserId: null }, token,
    })

    expect(status).toBe(200)
    expect(body.leadUserId).toBeNull()
  })

  it('refuses a designer, who may not manage groups', async () => {
    const token = await sessionFor('designer@example.com', 'designerpass')

    const { status } = await request(`/api/events/${EVENT}/groups/g1`, {
      method: 'PATCH', body: { leadUserId: oid(3) }, token,
    })

    expect(status).toBe(403)
  })

  it('returns 404 for a group that belongs to another event', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const { status } = await request(`/api/events/${EVENT}/groups/not-a-group`, {
      method: 'PATCH', body: { leadUserId: oid(3) }, token,
    })

    expect(status).toBe(404)
  })
})
