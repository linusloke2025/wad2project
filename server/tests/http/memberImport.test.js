import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'

import { createApp } from '../../src/app.js'
import { createTokenService } from '../../src/auth/tokens.js'
import { hashPassword, verifyPassword } from '../../src/auth/passwords.js'
import { createConflictService } from '../../src/services/conflictService.js'
import { createLiveState } from '../../src/realtime/liveState.js'

// Community mass-add: the admin path for onboarding a roster.
//
// The spec's failure mode is explicit — an invalid row must be reported per row while the valid
// rows still import, with no partial corruption — so the assertions below care as much about
// what happens to the good rows when one is bad as about the happy path.
//
// Accounts are provisioned, never self-registered, so an imported account must arrive on a
// temporary password and be forced to change it.

const oid = (n) => `64b7f0c2f1a2b3c4d5e6f7${String(n).padStart(2, '0')}`
const SECRET = 'test-secret-do-not-use-in-production'

const HEADER = 'name,email,tempPassword\n'

let httpServer
let baseUrl
let repositories

function makeRepositories() {
  const users = [
    { id: oid(1), email: 'admin@example.com', passwordHash: null, mustChangePassword: false },
    { id: oid(2), email: 'member@example.com', passwordHash: null, mustChangePassword: false },
    { id: oid(3), email: 'existing@example.com', passwordHash: null, mustChangePassword: false },
  ]
  const memberships = [
    { userId: oid(1), communityId: 'c1', role: 'admin' },
    { userId: oid(2), communityId: 'c1', role: 'user' },
    // Belongs to another community only, so importing them here should add a membership, not a
    // second account.
    { userId: oid(3), communityId: 'c-other', role: 'user' },
  ]
  const state = { nextId: 100 }

  return {
    users: {
      async findByEmail(email) {
        return users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()) ?? null
      },
      async findById(id) { return users.find((u) => u.id === id) ?? null },
      async create({ email, name, passwordHash: hash, mustChangePassword }) {
        const user = { id: oid(state.nextId++), email: String(email).toLowerCase(), name, passwordHash: hash, mustChangePassword }
        users.push(user)
        return user
      },
      async updatePassword() { return null },
      _all: users,
    },
    memberships: {
      async listByUser(userId) { return memberships.filter((m) => m.userId === userId) },
      async find(userId, communityId) {
        return memberships.find((m) => m.userId === userId && m.communityId === communityId) ?? null
      },
      async create({ userId, communityId, role }) {
        memberships.push({ userId, communityId, role })
        return { userId, communityId, role }
      },
      _all: memberships,
    },
    events: { async create() { return null }, async findById() { return null }, async listByCommunity() { return [] } },
    zones: { async create() { return null }, async listByEvent() { return [] } },
    groups: { async create() { return null }, async findById() { return null }, async listByEvent() { return [] } },
    assignments: { async create() { return null }, async listByEvent() { return [] } },
    announcements: { async create() { return null }, async findById() { return null }, async listByEvent() { return [] } },
    announcementAcks: { async upsert() { return null }, async listByAnnouncement() { return [] } },
    statusUpdates: { async create() { return null }, async listByEvent() { return [] } },
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
    'member@example.com': 'memberpass',
    'existing@example.com': 'existingpass',
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

beforeEach(() => {
  // Drop accounts created by a previous test, keeping the seeded three.
  repositories.users._all.length = 3
  repositories.memberships._all.length = 3
})

describe('POST /api/members/import', () => {
  it('imports a roster and reports how many were added', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const csv = `${HEADER}Alice Tan,alice@example.com,temp1234\nBob Lee,bob@example.com,temp5678\n`

    const { status, body } = await request('/api/members/import', { method: 'POST', body: { csv }, token })

    expect(status).toBe(201)
    expect(body.imported).toBe(2)
    expect(body.errors).toEqual([])
  })

  it('provisions imported accounts on a temporary password that must be changed', async () => {
    // Accounts are admin-created, so nobody arrives with a password of their own choosing.
    const token = await sessionFor('admin@example.com', 'adminpass')
    const csv = `${HEADER}Alice Tan,alice@example.com,temp1234\n`

    await request('/api/members/import', { method: 'POST', body: { csv }, token })

    const created = await repositories.users.findByEmail('alice@example.com')
    expect(created).not.toBeNull()
    expect(created.mustChangePassword).toBe(true)
    expect(await verifyPassword('temp1234', created.passwordHash)).toBe(true)
  })

  it('adds a community membership for someone who already has an account', async () => {
    // A person can belong to several communities, so this must not create a second account.
    const token = await sessionFor('admin@example.com', 'adminpass')
    const csv = `${HEADER}Existing Person,existing@example.com,temp1234\n`

    const { body } = await request('/api/members/import', { method: 'POST', body: { csv }, token })

    expect(body.imported).toBe(1)
    expect(repositories.users._all.filter((u) => u.email === 'existing@example.com')).toHaveLength(1)
    expect(await repositories.memberships.find(oid(3), 'c1')).not.toBeNull()
  })

  it('reports a row that is already a member without failing the rest', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')
    const csv = `${HEADER}Already Here,member@example.com,temp1234\nNew Person,new@example.com,temp5678\n`

    const { status, body } = await request('/api/members/import', { method: 'POST', body: { csv }, token })

    expect(status).toBe(201)
    expect(body.imported).toBe(1)
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0].message).toMatch(/already/i)
  })

  it('imports the good rows and reports the bad one, with its line number', async () => {
    // The spec's stated failure mode: one bad row must not lose the rest, and must not half-apply.
    const token = await sessionFor('admin@example.com', 'adminpass')
    const csv = `${HEADER}Good One,good1@example.com,temp1234\nBad Row,not-an-email,temp1234\nGood Two,good2@example.com,temp5678\n`

    const { status, body } = await request('/api/members/import', { method: 'POST', body: { csv }, token })

    expect(status).toBe(201)
    expect(body.imported).toBe(2)
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0].line).toBe(3)
    expect(await repositories.users.findByEmail('good2@example.com')).not.toBeNull()
  })

  it('rejects a file whose header is missing a required column', async () => {
    // A header problem invalidates every row, so it is a bad request rather than a row error.
    const token = await sessionFor('admin@example.com', 'adminpass')

    const { status, body } = await request('/api/members/import', {
      method: 'POST',
      body: { csv: 'name,email\nAlice,alice@example.com\n' },
      token,
    })

    expect(status).toBe(400)
    expect(body.error).toMatch(/tempPassword/i)
  })

  it('rejects a request with no csv content', async () => {
    const token = await sessionFor('admin@example.com', 'adminpass')

    const { status } = await request('/api/members/import', { method: 'POST', body: {}, token })

    expect(status).toBe(400)
  })

  it('refuses an ordinary member, since provisioning accounts is an admin act', async () => {
    const token = await sessionFor('member@example.com', 'memberpass')

    const { status } = await request('/api/members/import', {
      method: 'POST',
      body: { csv: `${HEADER}Sneaky,sneaky@example.com,temp1234\n` },
      token,
    })

    expect(status).toBe(403)
  })

  it('refuses an unauthenticated request', async () => {
    const { status } = await request('/api/members/import', {
      method: 'POST',
      body: { csv: `${HEADER}x,x@example.com,temp1234\n` },
    })

    expect(status).toBe(401)
  })
})
