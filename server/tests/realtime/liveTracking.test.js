import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import { io as ioClient } from 'socket.io-client'

import { createApp } from '../../src/app.js'
import { createTokenService } from '../../src/auth/tokens.js'
import { hashPassword } from '../../src/auth/passwords.js'
import { createConflictService } from '../../src/services/conflictService.js'
import { createLiveState } from '../../src/realtime/liveState.js'
import { createRealtimeServer } from '../../src/realtime/socketServer.js'

// Live tracking over real sockets.
//
// A real socket.io client connects to a real HTTP server, so the handshake, the join check, the
// permission check on each update, and the broadcast are all genuinely exercised. Only MongoDB
// is faked.
//
// The riskiest thing here is not the plumbing but the authorisation: a live board where any
// participant can move any group's marker is worse than no live board, because planners would
// trust it. Several tests below exist purely to pin that boundary.

const SECRET = 'test-secret-do-not-use-in-production'
const WINDOW = { start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T12:00:00+08:00' }

let httpServer
let baseUrl
let repositories
let liveState

const oid = (n) => `64b7f0c2f1a2b3c4d5e6f7${String(n).padStart(2, '0')}`

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

  // g1 is led by the 'lead' account; g2 has no lead at all.
  const groups = [
    { id: oid(11), eventId: oid(20), name: 'Group A', leadUserId: oid(3) },
    { id: oid(12), eventId: oid(20), name: 'Group B', leadUserId: null },
  ]

  const state = { events: [], zones: [], assignments: [], groups: [...groups], nextId: 1 }

  return {
    users: {
      async findByEmail(email) {
        return users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()) ?? null
      },
      async findById(id) {
        return users.find((u) => u.id === id) ?? null
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
      async create({ communityId, name, start, end, layoutMode, createdBy }) {
        const event = {
          id: state.events.length === 0 ? oid(20) : `${oid(20)}${state.events.length}`,
          communityId, name, start, end, layoutMode: layoutMode ?? 'plan', createdBy, status: 'draft',
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
        const zone = { id: `z${state.nextId++}`, eventId, name, kind: kind ?? 'zone', polygon }
        state.zones.push(zone)
        return zone
      },
      async listByEvent(eventId) {
        return state.zones.filter((z) => z.eventId === eventId)
      },
    },
    groups: {
      async create({ eventId, name, leadUserId }) {
        const group = { id: `g${state.nextId++}`, eventId, name, leadUserId: leadUserId ?? null }
        state.groups.push(group)
        return group
      },
      async listByEvent(eventId) {
        return state.groups.filter((g) => g.eventId === eventId)
      },
      async findById(groupId) {
        return state.groups.find((g) => g.id === groupId) ?? null
      },
    },
    assignments: {
      async create(fields) {
        state.assignments.push(fields)
        return fields
      },
      async listByEvent(eventId) {
        return state.assignments.filter((a) => a.eventId === eventId)
      },
    },
    _reset() {
      state.events = []
      state.zones = []
      state.assignments = []
      state.groups = [...groups]
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

function nextEvent(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve))
}

beforeAll(async () => {
  repositories = makeRepositories()
  liveState = createLiveState()

  for (const [email, plain] of Object.entries({
    'admin@example.com': 'adminpass',
    'planner@example.com': 'plannerpass',
    'lead@example.com': 'leadpass',
    'member@example.com': 'memberpass',
  })) {
    const user = await repositories.users.findByEmail(email)
    user.passwordHash = await hashPassword(plain)
  }

  const app = createApp({
    tokenService: createTokenService({ secret: SECRET }),
    repositories,
    conflictService: createConflictService({ onemapClient: null }),
    // The SAME store the socket layer uses. Without this the app builds its own, and the HTTP
    // snapshot would silently disagree with what sockets just broadcast.
    liveState,
  })

  httpServer = http.createServer(app)
  createRealtimeServer({
    httpServer,
    tokenService: createTokenService({ secret: SECRET }),
    repositories,
    liveState,
  })

  await new Promise((resolve) => httpServer.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`
})

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve))
})

beforeEach(async () => {
  repositories._reset()
  liveState.clearEvent(oid(20))
  // The event lives in the fixture store; recreate it for each test.
  await repositories.events.create({
    communityId: 'c1', name: 'Parade', ...WINDOW, layoutMode: 'plan', createdBy: oid(1),
  })
})

describe('realtime — handshake', () => {
  it('refuses a connection with no token', async () => {
    await expect(connect(undefined)).rejects.toThrow()
  })

  it('refuses a connection with a forged token', async () => {
    const forged = createTokenService({ secret: 'the-wrong-secret' }).sign({
      userId: oid(3), role: 'user', communityId: 'c1',
    })

    await expect(connect(forged)).rejects.toThrow()
  })

  it('accepts a connection with a valid token', async () => {
    const socket = await connect(await sessionFor('lead@example.com', 'leadpass'))

    expect(socket.connected).toBe(true)
    socket.disconnect()
  })
})

describe('realtime — joining an event', () => {
  it('joins an event in the caller own community', async () => {
    const socket = await connect(await sessionFor('planner@example.com', 'plannerpass'))

    const ack = await emit(socket, 'event:join', { eventId: oid(20) })

    expect(ack.ok).toBe(true)
    socket.disconnect()
  })

  it('refuses to join an event that does not exist', async () => {
    const socket = await connect(await sessionFor('planner@example.com', 'plannerpass'))

    const ack = await emit(socket, 'event:join', { eventId: oid(99) })

    expect(ack.ok).toBe(false)
    socket.disconnect()
  })
})

describe('realtime — reporting status', () => {
  it('lets the group lead report, and every other client in the room sees it', async () => {
    const plannerSocket = await connect(await sessionFor('planner@example.com', 'plannerpass'))
    const leadSocket = await connect(await sessionFor('lead@example.com', 'leadpass'))
    await emit(plannerSocket, 'event:join', { eventId: oid(20) })
    await emit(leadSocket, 'event:join', { eventId: oid(20) })

    const broadcast = nextEvent(plannerSocket, 'status:changed')
    const ack = await emit(leadSocket, 'status:update', {
      eventId: oid(20), groupId: oid(11), status: 'moving',
    })

    expect(ack.ok).toBe(true)
    await expect(broadcast).resolves.toMatchObject({ groupId: oid(11), status: 'moving' })

    plannerSocket.disconnect()
    leadSocket.disconnect()
  })

  it('refuses an ordinary member reporting for a group they do not lead', async () => {
    // The core authorisation boundary: without this, any participant can move any marker.
    const socket = await connect(await sessionFor('member@example.com', 'memberpass'))
    await emit(socket, 'event:join', { eventId: oid(20) })

    const ack = await emit(socket, 'status:update', {
      eventId: oid(20), groupId: oid(11), status: 'arrived',
    })

    expect(ack.ok).toBe(false)
    socket.disconnect()
  })

  it('refuses reporting for a group with no lead at all', async () => {
    const socket = await connect(await sessionFor('lead@example.com', 'leadpass'))
    await emit(socket, 'event:join', { eventId: oid(20) })

    // g2 has leadUserId null, so even a lead account has no authority over it.
    const ack = await emit(socket, 'status:update', {
      eventId: oid(20), groupId: oid(12), status: 'moving',
    })

    expect(ack.ok).toBe(false)
    socket.disconnect()
  })

  it('lets a planner report on behalf of a group', async () => {
    const socket = await connect(await sessionFor('planner@example.com', 'plannerpass'))
    await emit(socket, 'event:join', { eventId: oid(20) })

    const ack = await emit(socket, 'status:update', {
      eventId: oid(20), groupId: oid(11), status: 'arrived',
    })

    expect(ack.ok).toBe(true)
    socket.disconnect()
  })

  it('refuses a status outside the defined set', async () => {
    const socket = await connect(await sessionFor('planner@example.com', 'plannerpass'))
    await emit(socket, 'event:join', { eventId: oid(20) })

    const ack = await emit(socket, 'status:update', {
      eventId: oid(20), groupId: oid(11), status: 'teleporting',
    })

    expect(ack.ok).toBe(false)
    socket.disconnect()
  })
})

describe('realtime — reporting position', () => {
  it('broadcasts a position and keeps the last status intact', async () => {
    const plannerSocket = await connect(await sessionFor('planner@example.com', 'plannerpass'))
    const leadSocket = await connect(await sessionFor('lead@example.com', 'leadpass'))
    await emit(plannerSocket, 'event:join', { eventId: oid(20) })
    await emit(leadSocket, 'event:join', { eventId: oid(20) })

    await emit(leadSocket, 'status:update', { eventId: oid(20), groupId: oid(11), status: 'moving' })

    const broadcast = nextEvent(plannerSocket, 'position:changed')
    const ack = await emit(leadSocket, 'position:update', {
      eventId: oid(20), groupId: oid(11), latitude: 1.31955, longitude: 103.84223,
    })

    expect(ack.ok).toBe(true)
    await expect(broadcast).resolves.toMatchObject({ groupId: oid(11) })

    const [entry] = liveState.snapshot(oid(20))
    expect(entry.position).toEqual({ latitude: 1.31955, longitude: 103.84223 })
    expect(entry.status).toBe('moving')

    plannerSocket.disconnect()
    leadSocket.disconnect()
  })

  it('refuses a position for a group the caller does not lead', async () => {
    const socket = await connect(await sessionFor('member@example.com', 'memberpass'))
    await emit(socket, 'event:join', { eventId: oid(20) })

    const ack = await emit(socket, 'position:update', {
      eventId: oid(20), groupId: oid(11), latitude: 1.3, longitude: 103.8,
    })

    expect(ack.ok).toBe(false)
    socket.disconnect()
  })

  it('refuses a position that is not a usable coordinate', async () => {
    const socket = await connect(await sessionFor('planner@example.com', 'plannerpass'))
    await emit(socket, 'event:join', { eventId: oid(20) })

    const ack = await emit(socket, 'position:update', {
      eventId: oid(20), groupId: oid(11), latitude: 'north', longitude: 103.8,
    })

    expect(ack.ok).toBe(false)
    socket.disconnect()
  })

  it('does not send updates to a client that never joined the event', async () => {
    const plannerSocket = await connect(await sessionFor('planner@example.com', 'plannerpass'))
    const leadSocket = await connect(await sessionFor('lead@example.com', 'leadpass'))
    // The planner deliberately stays out of the room.
    await emit(leadSocket, 'event:join', { eventId: oid(20) })

    let leaked = false
    plannerSocket.on('status:changed', () => {
      leaked = true
    })

    await emit(leadSocket, 'status:update', { eventId: oid(20), groupId: oid(11), status: 'moving' })
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(leaked).toBe(false)

    plannerSocket.disconnect()
    leadSocket.disconnect()
  })
})

describe('realtime — snapshot endpoint', () => {
  it('gives a planner the whole board, so a reconnecting client can resync', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')
    liveState.setStatus({ eventId: oid(20), groupId: oid(11), status: 'arrived' })
    liveState.setStatus({ eventId: oid(20), groupId: oid(12), status: 'moving' })

    const { status, body } = await request(`/api/events/${oid(20)}/live`, { token })

    expect(status).toBe(200)
    expect(body.groups).toHaveLength(2)
    expect(body.groups.map((group) => group.groupId).sort()).toEqual([oid(11), oid(12)].sort())
  })

  it('scopes an ordinary user to the group they lead, not the whole board', async () => {
    // The spec grants a plain user live.view but scoped to their own group: they need to see
    // their own position, not every other group's. The lead account leads g1 only; g2 has no
    // lead, so nothing is theirs.
    const token = await sessionFor('lead@example.com', 'leadpass')
    liveState.setStatus({ eventId: oid(20), groupId: oid(11), status: 'arrived' })
    liveState.setStatus({ eventId: oid(20), groupId: oid(12), status: 'moving' })

    const { status, body } = await request(`/api/events/${oid(20)}/live`, { token })

    expect(status).toBe(200)
    expect(body.groups.map((group) => group.groupId)).toEqual([oid(11)])
  })

  it('shows an ordinary member who leads nothing an empty board rather than other groups', async () => {
    const token = await sessionFor('member@example.com', 'memberpass')
    liveState.setStatus({ eventId: oid(20), groupId: oid(11), status: 'arrived' })

    const { status, body } = await request(`/api/events/${oid(20)}/live`, { token })

    expect(status).toBe(200)
    expect(body.groups).toEqual([])
  })
})
