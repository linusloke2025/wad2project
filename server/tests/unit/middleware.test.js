import { describe, it, expect, vi } from 'vitest'

// Namespace imports so missing exports fail as behaviour, not as an ESM link error.
import * as requireAuthModule from '../../src/http/middleware/requireAuth.js'
import * as requireCapabilityModule from '../../src/http/middleware/requireCapability.js'
import { createTokenService } from '../../src/auth/tokens.js'

// Acceptance criterion 3: every disallowed role action must be refused by the SERVER.
//
// These are tested by driving the middleware directly with fake req/res/next rather than by
// spinning up Express and a database. That keeps the feedback loop at milliseconds and proves
// the guard itself, independently of routing and persistence.

const SECRET = 'test-secret-do-not-use-in-production'
const tokenService = createTokenService({ secret: SECRET })

function fakeRes() {
  const res = {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.payload = body
      return this
    },
  }
  return res
}

function fakeReq({ token, body = {}, params = {} } = {}) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
    params,
  }
}

describe('requireAuth', () => {
  const middleware = requireAuthModule.requireAuth({ tokenService })

  it('rejects a request with no Authorization header', () => {
    const res = fakeRes()
    const next = vi.fn()

    middleware(fakeReq(), res, next)

    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects a header that is not a Bearer token', () => {
    const res = fakeRes()
    const next = vi.fn()
    const req = { headers: { authorization: 'Basic abc123' }, body: {}, params: {} }

    middleware(req, res, next)

    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects a forged or malformed token', () => {
    const res = fakeRes()
    const next = vi.fn()

    middleware(fakeReq({ token: 'not.a.jwt' }), res, next)

    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects a token signed with the wrong secret', () => {
    const other = createTokenService({ secret: 'a-different-secret' })
    const forged = other.sign({ userId: 'u1', role: 'root', communityId: 'c1' })
    const res = fakeRes()
    const next = vi.fn()

    middleware(fakeReq({ token: forged }), res, next)

    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects an expired token', () => {
    const expired = createTokenService({ secret: SECRET, expiresIn: '-10s' })
    const res = fakeRes()
    const next = vi.fn()

    middleware(fakeReq({ token: expired.sign({ userId: 'u1', role: 'root', communityId: 'c1' }) }), res, next)

    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('attaches the membership claims and continues for a valid token', () => {
    const token = tokenService.sign({ userId: 'u1', role: 'planner', communityId: 'c1' })
    const req = fakeReq({ token })
    const res = fakeRes()
    const next = vi.fn()

    middleware(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(res.statusCode).toBeNull()
    // Exact equality kept deliberately: this asserts the whole contract of req.auth, so a new
    // claim arriving unnoticed fails here rather than surfacing as a subtly different session.
    expect(req.auth).toEqual({
      userId: 'u1',
      role: 'planner',
      communityId: 'c1',
      mustChangePassword: false,
    })
  })
})

describe('requireCapability', () => {
  it('lets an allowed role through', async () => {
    const guard = requireCapabilityModule.requireCapability('event.create')
    const req = { auth: { userId: 'u1', role: 'admin', communityId: 'c1' }, body: {}, params: {} }
    const res = fakeRes()
    const next = vi.fn()

    await guard(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(res.statusCode).toBeNull()
  })

  it('refuses a disallowed role with 403', async () => {
    const guard = requireCapabilityModule.requireCapability('event.create')
    const req = { auth: { userId: 'u1', role: 'planner', communityId: 'c1' }, body: {}, params: {} }
    const res = fakeRes()
    const next = vi.fn()

    await guard(req, res, next)

    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('refuses with 401 when authentication never ran', async () => {
    const guard = requireCapabilityModule.requireCapability('event.create')
    const req = { body: {}, params: {} }
    const res = fakeRes()
    const next = vi.fn()

    await guard(req, res, next)

    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('blocks an admin from managing another admin (privilege escalation)', async () => {
    const guard = requireCapabilityModule.requireCapability('user.manage', {
      resolveContext: (req) => ({ targetRole: req.body.targetRole }),
    })
    const req = {
      auth: { userId: 'u1', role: 'admin', communityId: 'c1' },
      body: { targetRole: 'admin' },
      params: {},
    }
    const res = fakeRes()
    const next = vi.fn()

    await guard(req, res, next)

    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('allows an admin to manage an ordinary user', async () => {
    const guard = requireCapabilityModule.requireCapability('user.manage', {
      resolveContext: (req) => ({ targetRole: req.body.targetRole }),
    })
    const req = {
      auth: { userId: 'u1', role: 'admin', communityId: 'c1' },
      body: { targetRole: 'user' },
      params: {},
    }
    const res = fakeRes()
    const next = vi.fn()

    await guard(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(res.statusCode).toBeNull()
  })

  it('supports an async context resolver, for lookups like group leadership', async () => {
    const guard = requireCapabilityModule.requireCapability('status.report', {
      // Group leadership lives in the database, so the resolver is allowed to be async.
      resolveContext: async () => ({ isGroupLead: true }),
    })
    const req = { auth: { userId: 'u1', role: 'user', communityId: 'c1' }, body: {}, params: {} }
    const res = fakeRes()
    const next = vi.fn()

    await guard(req, res, next)

    expect(next).toHaveBeenCalledOnce()
  })

  it('refuses an ordinary user reporting status without leading the group', async () => {
    const guard = requireCapabilityModule.requireCapability('status.report')
    const req = { auth: { userId: 'u1', role: 'user', communityId: 'c1' }, body: {}, params: {} }
    const res = fakeRes()
    const next = vi.fn()

    await guard(req, res, next)

    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })
})
