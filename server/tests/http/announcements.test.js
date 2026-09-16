import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { io as ioClient } from 'socket.io-client'

import { createApp } from '../../src/app.js'
import { createTokenService } from '../../src/auth/tokens.js'
import { hashPassword } from '../../src/auth/passwords.js'
import { createConflictService } from '../../src/services/conflictService.js'
import { createLiveState } from '../../src/realtime/liveState.js'
import { createBroadcaster } from '../../src/realtime/broadcaster.js'
import { createRealtimeServer } from '../../src/realtime/socketServer.js'

// Announcements and their acknowledgement tallies, over real HTTP.
//
// Two properties matter most:
//
//   1. Authority. Authoring a broadcast is a planning act; acknowledging is a group-lead act.
//      A member must not be able to answer on another group's behalf, or the tally lies.
//   2. One-way. The acknowledgement accepts a fixed signal and nothing else. There is no field
//      for a reply, because a reply box would make this chat — the thing being replaced.

const oid = (n) => `64b7f0c2f1a2b3c4d5e6f7${String(n).padStart(2, '0')}`
const SECRET = 'test-secret-do-not-use-in-production'
const WINDOW = { start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T12:00:00+08:00' }

let httpServer
let baseUrl
let repositories

function makeRepositories() {
  const users = [
    { id: oid(1), email: 'admin@example.com', passwordHash: null, mustChangePassword: false },
    { id: oid(2), email: 'planner@example.com', passwordHash: null, mustChangePassword: false },
    { id: oid(3), email: 'lead@example.com', passwordHash: null, mustChangePassword: false },
    { id: oid(4), email: 'member@example.com', passwordHash: null, mustChangePassword: false },
  ]
  const memberships = [
    { userId: oid(1), communityId: 'c1', role: 'admin' },
    { userId: oid(2), communityId: 'c1', role: 'planner' },
    { userId: oid(3), communityId: 'c1', role: 'user' },
    { userId: oid(4), communityId: 'c1', role: 'user' },
  ]
  const groupFixtures = [
    { id: oid(11), eventId: oid(20), name: 'Group A', leadUserId: oid(3) },
    { id: oid(12), eventId: oid(20), name: 'Group B', leadUserId: null },
  ]

  const state = { events: [], zones: [], groups: [...groupFixtures], assignments: [], announcements: [], acks: [], nextId: 1 }

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
          id: state.events.length === 0 ? oid(20) : `${oid(20)}${state.events.length}`,
          communityId, name, start, end, layoutMode: layoutMode ?? 'plan', createdBy,
        }
        state.events.push(event)
        return event
      },
      async findById(eventId) { return state.events.find((e) => e.id === eventId) ?? null },
      async listByCommunity(communityId) { return state.events.filter((e) => e.communityId === communityId) },
    },
    zones: { async create() { return null }, async listByEvent() { return [] } },
    groups: {
      async create() { return null },
      async findById(groupId) { return state.groups.find((g) => g.id === groupId) ?? null },
      async listByEvent(eventId) { return state.groups.filter((g) => g.eventId === eventId) },
    },
    assignments: { async create() { return null }, async listByEvent() { return [] } },
    announcements: {
      async create({ eventId, body, createdBy }) {
        const announcement = { id: `an${state.nextId++}`, eventId, body, createdBy, createdAt: '2026-03-01T08:00:00.000Z' }
        state.announcements.push(announcement)
        return announcement
      },
      async findById(id) { return state.announcements.find((a) => a.id === id) ?? null },
      async listByEvent(eventId) { return state.announcements.filter((a) => a.eventId === eventId) },
    },
    announcementAcks: {
      async upsert({ announcementId, groupId, status, at }) {
        const existing = state.acks.find((a) => a.announcementId === announcementId && a.groupId === groupId)
        if (existing) {
          existing.status = status
          existing.at = at
          return existing
        }
        const created = { announcementId, groupId, status, at }
        state.acks.push(created)
        return created
      },
      async listByAnnouncement(announcementId) {
        return state.acks.filter((a) => a.announcementId === announcementId)
      },
    },
    _reset() {
      state.events = []
      state.zones = []
      state.groups = [...groupFixtures]
      state.assignments = []
      state.announcements = []
      state.acks = []
      state.nextId = 1
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
  for (const [email, plain] of Object.entries({
    'admin@example.com': 'adminpass',
    'planner@example.com': 'plannerpass',
    'lead@example.com': 'leadpass',
    'member@example.com': 'memberpass',
  })) {
    const user = await repositories.users.findByEmail(email)
    user.passwordHash = await hashPassword(plain)
  }

  const broadcaster = createBroadcaster()
  const app = createApp({
    tokenService: createTokenService({ secret: SECRET }),
    repositories,
    conflictService: createConflictService({ onemapClient: null }),
    liveState: createLiveState(),
    broadcaster,
  })
  const { createServer } = await import('node:http')
  httpServer = createServer(app)
  createRealtimeServer({
    httpServer,
    tokenService: createTokenService({ secret: SECRET }),
    repositories,
    liveState: createLiveState(),
    broadcaster,
  })
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

describe('POST /api/events/:id/announcements', () => {
  it('lets a planner broadcast an announcement', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const { status, body } = await request(`/api/events/${oid(20)}/announcements`, {
      method: 'POST',
      body: { body: 'Group 3 is delayed 10 minutes — hold at the holding area.' },
      token,
    })

    expect(status).toBe(201)
    expect(body.id).toBeDefined()
    expect(body.body).toMatch(/delayed 10 minutes/)
  })

  it('refuses an ordinary user broadcasting', async () => {
    const token = await sessionFor('member@example.com', 'memberpass')

    const { status } = await request(`/api/events/${oid(20)}/announcements`, {
      method: 'POST',
      body: { body: 'Everyone move now' },
      token,
    })

    expect(status).toBe(403)
  })

  it('refuses an unauthenticated broadcast', async () => {
    const { status } = await request(`/api/events/${oid(20)}/announcements`, {
      method: 'POST',
      body: { body: 'Hello' },
    })

    expect(status).toBe(401)
  })

  it('rejects an empty announcement', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const { status } = await request(`/api/events/${oid(20)}/announcements`, {
      method: 'POST',
      body: { body: '   ' },
      token,
    })

    expect(status).toBe(400)
  })

  it('refuses an event in another community', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')
    const foreign = await repositories.events.create({
      communityId: 'c-other', name: 'Foreign', ...WINDOW, layoutMode: 'plan', createdBy: oid(1),
    })

    const { status } = await request(`/api/events/${foreign.id}/announcements`, {
      method: 'POST',
      body: { body: 'Sneaky' },
      token,
    })

    expect(status).toBe(404)
  })
})

describe('GET /api/events/:id/announcements', () => {
  it('lists announcements with a tally of who has answered', async () => {
    const plannerToken = await sessionFor('planner@example.com', 'plannerpass')
    const { body: created } = await request(`/api/events/${oid(20)}/announcements`, {
      method: 'POST',
      body: { body: 'Move to stage' },
      token: plannerToken,
    })
    const leadToken = await sessionFor('lead@example.com', 'leadpass')
    await request(`/api/events/${oid(20)}/announcements/${created.id}/ack`, {
      method: 'POST',
      body: { groupId: oid(11), status: 'acknowledged' },
      token: leadToken,
    })

    const { status, body } = await request(`/api/events/${oid(20)}/announcements`, { token: plannerToken })

    expect(status).toBe(200)
    const [announcement] = body.announcements
    expect(announcement.body).toBe('Move to stage')
    expect(announcement.acknowledgements.acknowledgedGroupIds).toEqual([oid(11)])
    // g2 has no lead, so it can never answer — the planner needs to see that.
    expect(announcement.acknowledgements.awaitingResponseGroupIds).toEqual([oid(12)])
    expect(announcement.acknowledgements.allAcknowledged).toBe(false)
  })

  it('lets an ordinary member read announcements, since they must reach the ground', async () => {
    const plannerToken = await sessionFor('planner@example.com', 'plannerpass')
    await request(`/api/events/${oid(20)}/announcements`, {
      method: 'POST', body: { body: 'Briefing at 0800' }, token: plannerToken,
    })
    const memberToken = await sessionFor('member@example.com', 'memberpass')

    const { status, body } = await request(`/api/events/${oid(20)}/announcements`, { token: memberToken })

    expect(status).toBe(200)
    expect(body.announcements).toHaveLength(1)
  })
})

describe('POST /api/events/:id/announcements/:announcementId/ack', () => {
  async function broadcastAsPlanner() {
    const token = await sessionFor('planner@example.com', 'plannerpass')
    const { body } = await request(`/api/events/${oid(20)}/announcements`, {
      method: 'POST', body: { body: 'Hold position' }, token,
    })
    return body.id
  }

  it('records a group lead acknowledgement against the right group', async () => {
    const announcementId = await broadcastAsPlanner()
    const token = await sessionFor('lead@example.com', 'leadpass')

    const { status } = await request(`/api/events/${oid(20)}/announcements/${announcementId}/ack`, {
      method: 'POST',
      body: { groupId: oid(11), status: 'need_help' },
      token,
    })

    expect(status).toBe(204)

    // Verify it actually landed, rather than trusting the status code.
    const plannerToken = await sessionFor('planner@example.com', 'plannerpass')
    const { body } = await request(`/api/events/${oid(20)}/announcements`, { token: plannerToken })
    expect(body.announcements[0].acknowledgements.needHelpGroupIds).toEqual([oid(11)])
  })

  it('refuses a member acknowledging for a group they do not lead', async () => {
    // Without this, the tally lies: one person could answer for every group.
    const announcementId = await broadcastAsPlanner()
    const token = await sessionFor('member@example.com', 'memberpass')

    const { status } = await request(`/api/events/${oid(20)}/announcements/${announcementId}/ack`, {
      method: 'POST',
      body: { groupId: oid(11), status: 'acknowledged' },
      token,
    })

    expect(status).toBe(403)
  })

  it('refuses an acknowledgement signal outside the fixed set', async () => {
    const announcementId = await broadcastAsPlanner()
    const token = await sessionFor('lead@example.com', 'leadpass')

    const { status } = await request(`/api/events/${oid(20)}/announcements/${announcementId}/ack`, {
      method: 'POST',
      body: { groupId: oid(11), status: 'maybe_later' },
      token,
    })

    expect(status).toBe(400)
  })

  it('accepts a changed answer, replacing the earlier one rather than double-counting', async () => {
    const announcementId = await broadcastAsPlanner()
    const token = await sessionFor('lead@example.com', 'leadpass')

    await request(`/api/events/${oid(20)}/announcements/${announcementId}/ack`, {
      method: 'POST', body: { groupId: oid(11), status: 'need_help' }, token,
    })
    await request(`/api/events/${oid(20)}/announcements/${announcementId}/ack`, {
      method: 'POST', body: { groupId: oid(11), status: 'acknowledged' }, token,
    })

    const plannerToken = await sessionFor('planner@example.com', 'plannerpass')
    const { body } = await request(`/api/events/${oid(20)}/announcements`, { token: plannerToken })

    const tally = body.announcements[0].acknowledgements
    expect(tally.acknowledgedGroupIds).toEqual([oid(11)])
    expect(tally.needHelpGroupIds).toEqual([])
    expect(tally.counts).toEqual({ acknowledged: 1, need_help: 0, cant_comply: 0 })
  })

  it('has no field for a free-text reply, so an attempt to send one is ignored', async () => {
    // The one-way boundary: a reply box would make this chat.
    const announcementId = await broadcastAsPlanner()
    const token = await sessionFor('lead@example.com', 'leadpass')

    await request(`/api/events/${oid(20)}/announcements/${announcementId}/ack`, {
      method: 'POST',
      body: { groupId: oid(11), status: 'acknowledged', comment: 'we are stuck behind the float' },
      token,
    })

    const plannerToken = await sessionFor('planner@example.com', 'plannerpass')
    const { body } = await request(`/api/events/${oid(20)}/announcements`, { token: plannerToken })

    const serialised = JSON.stringify(body)
    expect(serialised).not.toMatch(/stuck behind the float/)
    expect(serialised).not.toMatch(/comment/i)
  })

  it('refuses an acknowledgement for an announcement in another event', async () => {
    const announcementId = await broadcastAsPlanner()
    const token = await sessionFor('lead@example.com', 'leadpass')

    const { status } = await request(`/api/events/${oid(20)}9/announcements/${announcementId}/ack`, {
      method: 'POST',
      body: { groupId: oid(11), status: 'acknowledged' },
      token,
    })

    expect([403, 404]).toContain(status)
  })
})

describe('announcement delivery over the socket', () => {
  function connect(token) {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, { auth: { token }, reconnection: false })
      const timer = setTimeout(() => reject(new Error('connect timeout')), 5000)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(socket)
      })
      socket.once('connect_error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  function emit(socket, event, payload) {
    return new Promise((resolve) => socket.emit(event, payload, resolve))
  }

  it('pushes a new announcement to clients already in the event room', async () => {
    // Without this, a lead only learns of a change when their board happens to refetch.
    const leadSocket = await connect(await sessionFor('lead@example.com', 'leadpass'))
    await emit(leadSocket, 'event:join', { eventId: oid(20) })

    const delivered = new Promise((resolve) => leadSocket.once('announcement:created', resolve))

    const plannerToken = await sessionFor('planner@example.com', 'plannerpass')
    await request(`/api/events/${oid(20)}/announcements`, {
      method: 'POST',
      body: { body: 'Group 3 delayed 10 minutes' },
      token: plannerToken,
    })

    await expect(delivered).resolves.toMatchObject({ body: 'Group 3 delayed 10 minutes' })
    leadSocket.disconnect()
  })

  it('does not push an announcement to a client that never joined the event', async () => {
    const outsiderSocket = await connect(await sessionFor('member@example.com', 'memberpass'))

    let leaked = false
    outsiderSocket.on('announcement:created', () => {
      leaked = true
    })

    const plannerToken = await sessionFor('planner@example.com', 'plannerpass')
    await request(`/api/events/${oid(20)}/announcements`, {
      method: 'POST', body: { body: 'Internal note' }, token: plannerToken,
    })
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(leaked).toBe(false)
    outsiderSocket.disconnect()
  })
})
