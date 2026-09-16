import { describe, it, expect } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as tokens from '../../src/auth/tokens.js'

// Auth tokens carry the ACTIVE membership, not just the user.
//
// Roles are per-community in this app (docs/SPEC.md section 4), so a token names the user AND
// the community they are currently acting in. Switching communities issues a new token — which
// is why `communityId` is part of the contract rather than something looked up per request.

const SECRET = 'test-secret-do-not-use-in-production'
const CLAIMS = { userId: 'u1', role: 'planner', communityId: 'c1' }

describe('createTokenService', () => {
  it('refuses to build a service without a secret', () => {
    // Misconfiguration must fail loudly at startup, not silently sign with an empty key.
    expect(() => tokens.createTokenService({})).toThrow()
    expect(() => tokens.createTokenService({ secret: '' })).toThrow()
  })
})

describe('sign / verify', () => {
  it('round-trips the membership claims', () => {
    const service = tokens.createTokenService({ secret: SECRET })

    const verified = service.verify(service.sign(CLAIMS))

    expect(verified.userId).toBe('u1')
    expect(verified.role).toBe('planner')
    expect(verified.communityId).toBe('c1')
  })

  it('rejects a token signed with a different secret', () => {
    const signer = tokens.createTokenService({ secret: 'other-secret' })
    const verifier = tokens.createTokenService({ secret: SECRET })

    expect(() => verifier.verify(signer.sign(CLAIMS))).toThrow()
  })

  it('rejects an expired token', () => {
    const service = tokens.createTokenService({ secret: SECRET, expiresIn: '-10s' })

    expect(() => service.verify(service.sign(CLAIMS))).toThrow()
  })

  it('rejects a malformed token', () => {
    const service = tokens.createTokenService({ secret: SECRET })

    expect(() => service.verify('not.a.jwt')).toThrow()
    expect(() => service.verify('')).toThrow()
    expect(() => service.verify(undefined)).toThrow()
  })

  it('exposes the reason for failure so the middleware can distinguish expiry from tampering', () => {
    const service = tokens.createTokenService({ secret: SECRET })
    const expired = tokens.createTokenService({ secret: SECRET, expiresIn: '-10s' })

    // jsonwebtoken names its errors; the middleware uses these to decide 401 semantics.
    expect(() => expired.verify(expired.sign(CLAIMS))).toThrowError(/expired/i)
    expect(() => service.verify('not.a.jwt')).toThrowError(/jwt|malformed|invalid/i)
  })
})
