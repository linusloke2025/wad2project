import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'

import { createApp } from '../../src/app.js'
import { createTokenService } from '../../src/auth/tokens.js'
import { hashPassword } from '../../src/auth/passwords.js'
import { createConflictService } from '../../src/services/conflictService.js'
import { createLiveState } from '../../src/realtime/liveState.js'

// Layout image upload for floor-plan events.
//
// A Plan layout is an uploaded floor plan with zones drawn over it, so without an upload there is
// nothing for a designer to work on and the app's core loop — designer places zones, planner
// schedules, conflicts surface — cannot be driven by a user at all.
//
// Storage is behind a repository interface rather than reached directly, so these tests exercise
// real multipart parsing and validation without needing GridFS or a database. The bytes are
// checked byte-for-byte on the way back out, because an image that merely returns 200 and the
// wrong content is the kind of failure a screenshot would not reveal.

const oid = (n) => `64b7f0c2f1a2b3c4d5e6f7${String(n).padStart(2, '0')}`
const SECRET = 'test-secret-do-not-use-in-production'

// Smallest valid-looking PNG header; the route validates the declared type and size, not the
// pixels, which is the honest limit of what a server can cheaply check.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])

let httpServer
let baseUrl
let repositories

function makeRepositories() {
  const users = [
    { id: oid(1), email: 'designer@example.com', passwordHash: null, mustChangePassword: false },
    { id: oid(2), email: 'planner@example.com', passwordHash: null, mustChangePassword: false },
  ]
  const memberships = [
    { userId: oid(1), communityId: 'c1', role: 'layout_designer' },
    { userId: oid(2), communityId: 'c1', role: 'planner' },
  ]

  const state = { events: [], images: new Map(), nextId: 1, eventsUpdated: [] }

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
          layoutMode: layoutMode ?? 'plan', createdBy, layoutImageId: null,
        }
        state.events.push(event)
        return event
      },
      async findById(eventId) { return state.events.find((e) => e.id === eventId) ?? null },
      async listByCommunity(communityId) { return state.events.filter((e) => e.communityId === communityId) },
      async updateLayoutImage(eventId, layoutImageId) {
        const event = state.events.find((e) => e.id === eventId)
        if (!event) return null
        event.layoutImageId = layoutImageId
        state.eventsUpdated.push({ eventId, layoutImageId })
        return event
      },
    },
    layoutImages: {
      async put({ eventId, buffer, contentType }) {
        const id = `img${state.nextId++}`
        state.images.set(id, { eventId, buffer: Buffer.from(buffer), contentType })
        return id
      },
      async get(id) { return state.images.get(id) ?? null },
      async remove(id) { state.images.delete(id) },
    },
    zones: { async create() { return null }, async listByEvent() { return [] } },
    groups: { async create() { return null }, async findById() { return null }, async listByEvent() { return [] } },
    assignments: { async create() { return null }, async listByEvent() { return [] } },
    announcements: { async create() { return null }, async findById() { return null }, async listByEvent() { return [] } },
    announcementAcks: { async upsert() { return null }, async listByAnnouncement() { return [] } },
    statusUpdates: { async create() { return null }, async listByEvent() { return [] } },
    _state: state,
    _reset() { state.events = []; state.images = new Map(); state.nextId = 1; state.eventsUpdated = [] },
  }
}

async function request(path, { method = 'GET', body, token, form, raw } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`

  let payload
  if (form) {
    payload = form
  } else if (raw !== undefined) {
    payload = raw
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: payload })
  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.startsWith('image/')) {
    return { status: response.status, contentType, bytes: Buffer.from(await response.arrayBuffer()) }
  }

  const text = await response.text()
  return { status: response.status, contentType, body: text ? JSON.parse(text) : null }
}

async function sessionFor(email, password) {
  const { body } = await request('/api/auth/login', { method: 'POST', body: { email, password } })
  return body.token
}

function imageForm(bytes = PNG_BYTES, type = 'image/png', name = 'plan.png') {
  const form = new FormData()
  form.append('image', new Blob([bytes], { type }), name)
  return form
}

beforeAll(async () => {
  repositories = makeRepositories()
  for (const [email, plain] of Object.entries({ 'designer@example.com': 'designerpass', 'planner@example.com': 'plannerpass' })) {
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
    communityId: 'c1', name: 'Ceremony',
    start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T12:00:00+08:00',
    layoutMode: 'plan', createdBy: oid(1),
  })
})

const EVENT = 'e1'

describe('POST /api/events/:eventId/layout/image', () => {
  it('stores an uploaded image and returns a URL to it', async () => {
    const token = await sessionFor('designer@example.com', 'designerpass')

    const { status, body } = await request(`/api/events/${EVENT}/layout/image`, {
      method: 'POST', form: imageForm(), token,
    })

    expect(status).toBe(201)
    expect(body.imageUrl).toContain(`/api/events/${EVENT}/layout/image`)
  })

  it('records the image against the event', async () => {
    const token = await sessionFor('designer@example.com', 'designerpass')

    await request(`/api/events/${EVENT}/layout/image`, { method: 'POST', form: imageForm(), token })

    const event = await repositories.events.findById(EVENT)
    expect(event.layoutImageId).toBeTruthy()
  })

  it('refuses a file that is not an image', async () => {
    // A PDF or a spreadsheet dropped into the wrong control should say so, not be stored as a
    // floor plan that then fails to render.
    const token = await sessionFor('designer@example.com', 'designerpass')
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }), 'plan.pdf')

    const { status } = await request(`/api/events/${EVENT}/layout/image`, { method: 'POST', form, token })

    expect(status).toBe(400)
  })

  it('refuses a request with no file attached', async () => {
    const token = await sessionFor('designer@example.com', 'designerpass')

    const { status } = await request(`/api/events/${EVENT}/layout/image`, {
      method: 'POST', form: new FormData(), token,
    })

    expect(status).toBe(400)
  })

  it('rejects an image larger than the size cap with 413', async () => {
    // The cap exists because uploads are stored in the database, which has a fixed quota.
    const token = await sessionFor('designer@example.com', 'designerpass')
    const oversized = new Uint8Array(6 * 1024 * 1024)

    const { status } = await request(`/api/events/${EVENT}/layout/image`, {
      method: 'POST', form: imageForm(oversized), token,
    })

    expect(status).toBe(413)
  })

  it('refuses a planner, who may see the layout but not change it', async () => {
    const token = await sessionFor('planner@example.com', 'plannerpass')

    const { status } = await request(`/api/events/${EVENT}/layout/image`, {
      method: 'POST', form: imageForm(), token,
    })

    expect(status).toBe(403)
  })

  it('refuses an unauthenticated upload', async () => {
    const { status } = await request(`/api/events/${EVENT}/layout/image`, { method: 'POST', form: imageForm() })

    expect(status).toBe(401)
  })

  it('returns 404 for an event in another community', async () => {
    const token = await sessionFor('designer@example.com', 'designerpass')
    const foreign = await repositories.events.create({
      communityId: 'c-other', name: 'Theirs',
      start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T12:00:00+08:00',
      layoutMode: 'plan', createdBy: oid(9),
    })

    const { status } = await request(`/api/events/${foreign.id}/layout/image`, {
      method: 'POST', form: imageForm(), token,
    })

    expect(status).toBe(404)
  })
})

describe('GET /api/events/:eventId/layout/image', () => {
  it('returns the stored bytes unchanged and with the right content type', async () => {
    const token = await sessionFor('designer@example.com', 'designerpass')
    await request(`/api/events/${EVENT}/layout/image`, { method: 'POST', form: imageForm(), token })

    const { status, contentType, bytes } = await request(`/api/events/${EVENT}/layout/image`, { token })

    expect(status).toBe(200)
    expect(contentType).toContain('image/png')
    expect(Buffer.compare(bytes, Buffer.from(PNG_BYTES))).toBe(0)
  })

  it('returns 404 when no image has been uploaded', async () => {
    const token = await sessionFor('designer@example.com', 'designerpass')

    const { status } = await request(`/api/events/${EVENT}/layout/image`, { token })

    expect(status).toBe(404)
  })

  it('refuses an unauthenticated read', async () => {
    const { status } = await request(`/api/events/${EVENT}/layout/image`)

    expect(status).toBe(401)
  })
})

describe('the layout endpoint exposes the uploaded image', () => {
  it('points imageUrl at the stored image for a Plan layout', async () => {
    const token = await sessionFor('designer@example.com', 'designerpass')
    await request(`/api/events/${EVENT}/layout/image`, { method: 'POST', form: imageForm(), token })

    const { status, body } = await request(`/api/events/${EVENT}/layout`, { token })

    expect(status).toBe(200)
    expect(body.layoutMode).toBe('plan')
    expect(body.imageUrl).toBe(`/api/events/${EVENT}/layout/image`)
    expect(body.warning).toBeNull()
  })

  it('still reports no image before one is uploaded', async () => {
    const token = await sessionFor('designer@example.com', 'designerpass')

    const { body } = await request(`/api/events/${EVENT}/layout`, { token })

    expect(body.imageUrl).toBeNull()
  })
})
