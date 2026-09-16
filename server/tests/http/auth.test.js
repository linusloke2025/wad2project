import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createApp } from '../../src/app.js'
import { createTokenService } from '../../src/auth/tokens.js'
import { hashPassword } from '../../src/auth/passwords.js'

// HTTP-level tests for the plan-first walking skeleton's first half: authenticate, then create
// an event only if the role permits.
//
// These run the real Express app over a real HTTP port with injected in-memory repositories.
// Acceptance criterion 3 requires the SERVER to refuse disallowed actions, so proving the
// guard functions in isolation is not enough — the refusal has to survive routing, body
// parsing, and the middleware chain to count.
//
// Repositories are injected rather than imported so the app is testable without MongoDB. The
// real Mongoose-backed implementations slot into the same interface.

const SECRET = 'test-secret-do-not-use-in-production'

let server
let baseUrl
let context

function makeRepositories() {
  const users = [
    { id: 'u-root', email: 'root@example.com', passwordHash: null, mustChangePassword: false },
    { id: 'u-admin', email: 'admin@example.com', passwordHash: null, mustChangePassword: false },
    { id: 'u-planner', email: 'planner@example.com', passwordHash: null, mustChangePassword: false },
    { id: 'u-temp', email: 'temp@example.com', passwordHash: null, mustChangePassword: true },
    { id: 'u-multi', email: 'multi@example.com', passwordHash: null, mustChangePassword: false },
  ]

  const memberships = [
    { userId: 'u-root', communityId: 'c1', role: 'root' },
    { userId: 'u-admin', communityId: 'c1', role: 'admin' },
    { userId: 'u-planner', communityId: 'c1', role: 'planner' },
    { userId: 'u-temp', communityId: 'c1', role: 'user' },
    // Belongs to two communities, to exercise community selection at login.
    { userId: 'u-multi', communityId: 'c1', role: 'planner' },
    { userId: 'u-multi', communityId: 'c2', role: 'user' },
  ]

  const events = []

  return {
    users: {
      async findByEmail(email) {
        return users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()) ?? null
      },
      async findById(id) {
        return users.find((u) => u.id === id) ?? null
      },
      async updatePassword(id, { passwordHash, mustChangePassword }) {
        const user = users.find((u) => u.id === id)
        if (!user) return null
        user.passwordHash = passwordHash
        user.mustChangePassword = mustChangePassword
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
      async create({ communityId, name, createdBy }) {
        const event = { id: `e${events.length + 1}`, communityId, name, createdBy, status: 'draft' }
        events.push(event)
        return event
      },
      async list() {
        return events
      },
    },
    _events: events,
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

async function login(email, password, communityId) {
  return request('/api/auth/login', {
    method: 'POST',
    body: { email, password, ...(communityId ? { communityId } : {}) },
  })
}

beforeAll(async () => {
  const repositories = makeRepositories()

  // Real hashes, so the login path exercises the real password verification.
  const passwordByEmail = {
    'root@example.com': 'rootpass',
    'admin@example.com': 'adminpass',
    'planner@example.com': 'plannerpass',
    'temp@example.com': 'temppass',
    'multi@example.com': 'multipass',
  }
  for (const [email, plain] of Object.entries(passwordByEmail)) {
    const user = await repositories.users.findByEmail(email)
    user.passwordHash = await hashPassword(plain)
  }

  const app = createApp({
    tokenService: createTokenService({ secret: SECRET }),
    repositories,
  })

  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  context = { repositories }
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

describe('POST /api/auth/login', () => {
  it('issues a token for correct credentials', async () => {
    const { status, body } = await login('admin@example.com', 'adminpass')

    expect(status).toBe(200)
    expect(typeof body.token).toBe('string')
    expect(body.role).toBe('admin')
    expect(body.communityId).toBe('c1')
  })

  it('refuses a wrong password', async () => {
    const { status } = await login('admin@example.com', 'wrong')

    expect(status).toBe(401)
  })

  it('refuses an unknown email with the same response as a wrong password', async () => {
    // Identical status and body: anything else lets an attacker enumerate accounts.
    const unknown = await login('nobody@example.com', 'whatever')
    const wrong = await login('admin@example.com', 'wrong')

    expect(unknown.status).toBe(wrong.status)
    expect(unknown.body).toEqual(wrong.body)
  })

  it('flags a temporary password so the client can force a change', async () => {
    const { status, body } = await login('temp@example.com', 'temppass')

    expect(status).toBe(200)
    expect(body.mustChangePassword).toBe(true)
  })

  it('selects the only membership when communityId is omitted', async () => {
    const { status, body } = await login('planner@example.com', 'plannerpass')

    expect(status).toBe(200)
    expect(body.communityId).toBe('c1')
  })

  it('demands a communityId when the user belongs to several', async () => {
    const { status, body } = await login('multi@example.com', 'multipass')

    expect(status).toBe(400)
    expect(body.communities.sort()).toEqual(['c1', 'c2'])
  })

  it('honours an explicit communityId among several', async () => {
    const { status, body } = await login('multi@example.com', 'multipass', 'c2')

    expect(status).toBe(200)
    expect(body.communityId).toBe('c2')
    expect(body.role).toBe('user')
  })

  it('refuses a community the user does not belong to', async () => {
    const { status } = await login('planner@example.com', 'plannerpass', 'c2')

    expect(status).toBe(403)
  })
})

describe('GET /api/me', () => {
  it('refuses an unauthenticated request', async () => {
    const { status } = await request('/api/me')

    expect(status).toBe(401)
  })

  it('returns the active membership for a valid token', async () => {
    const { body: session } = await login('planner@example.com', 'plannerpass')

    const { status, body } = await request('/api/me', { token: session.token })

    expect(status).toBe(200)
    expect(body).toEqual({
      userId: 'u-planner',
      role: 'planner',
      communityId: 'c1',
      mustChangePassword: false,
    })
  })

  it('refuses a forged token', async () => {
    const forged = createTokenService({ secret: 'the-wrong-secret' }).sign({
      userId: 'u-root',
      role: 'root',
      communityId: 'c1',
    })

    const { status } = await request('/api/me', { token: forged })

    expect(status).toBe(401)
  })
})

describe('POST /api/events — capability enforcement over HTTP', () => {
  it('refuses an unauthenticated request with 401', async () => {
    const { status } = await request('/api/events', { method: 'POST', body: { name: 'Parade' } })

    expect(status).toBe(401)
  })

  it('lets an admin create an event', async () => {
    const { body: session } = await login('admin@example.com', 'adminpass')

    const { status, body } = await request('/api/events', {
      method: 'POST',
      body: { name: 'National Day Parade' },
      token: session.token,
    })

    expect(status).toBe(201)
    expect(body.name).toBe('National Day Parade')
    expect(body.communityId).toBe('c1')
  })

  it('refuses a planner creating an event with 403, even though they may edit one', async () => {
    const { body: session } = await login('planner@example.com', 'plannerpass')

    const { status } = await request('/api/events', {
      method: 'POST',
      body: { name: 'Unauthorised Parade' },
      token: session.token,
    })

    expect(status).toBe(403)
  })

  it('refuses a user whose temporary password has not been changed', async () => {
    const { body: session } = await login('temp@example.com', 'temppass')

    const { status, body } = await request('/api/events', {
      method: 'POST',
      body: { name: 'Blocked' },
      token: session.token,
    })

    // A specific code, so the client can route to the change-password screen rather than
    // showing a bare "forbidden".
    expect(status).toBe(403)
    expect(body.code).toBe('PASSWORD_CHANGE_REQUIRED')
  })

  it('scopes a created event to the community in the token, not the request body', async () => {
    const { body: session } = await login('admin@example.com', 'adminpass')

    const { body } = await request('/api/events', {
      method: 'POST',
      body: { name: 'Sneaky', communityId: 'someone-elses-community' },
      token: session.token,
    })

    expect(body.communityId).toBe('c1')
  })
})

describe('POST /api/auth/password', () => {
  it('changes the password and clears the temporary flag', async () => {
    const { body: session } = await login('temp@example.com', 'temppass')

    const changed = await request('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: 'temppass', newPassword: 'a-proper-password' },
      token: session.token,
    })
    expect(changed.status).toBe(204)

    // The old password stops working and the new one works.
    expect((await login('temp@example.com', 'temppass')).status).toBe(401)

    const relogin = await login('temp@example.com', 'a-proper-password')
    expect(relogin.status).toBe(200)
    expect(relogin.body.mustChangePassword).toBe(false)
  })

  it('refuses a wrong current password', async () => {
    const { body: session } = await login('admin@example.com', 'adminpass')

    const { status } = await request('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: 'not-my-password', newPassword: 'whatever-1234' },
      token: session.token,
    })

    expect(status).toBe(401)
  })

  it('refuses a new password that is too short', async () => {
    const { body: session } = await login('admin@example.com', 'adminpass')

    const { status } = await request('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: 'adminpass', newPassword: 'short' },
      token: session.token,
    })

    expect(status).toBe(400)
  })

  it('refuses an unauthenticated request', async () => {
    const { status } = await request('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: 'x', newPassword: 'long-enough-password' },
    })

    expect(status).toBe(401)
  })
})
