import { describe, it, expect } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as passwords from '../../src/auth/passwords.js'

// Password handling for accounts that are provisioned by an admin and must change the
// temporary password on first login (docs/SPEC.md section 5.1).
//
// The wrapper exists so the rest of the app never touches the hashing library directly —
// that keeps the cost factor in one place and makes the contract testable.

const PLAIN = 'correct horse battery staple'

describe('hashPassword', () => {
  it('never returns the plaintext', async () => {
    const hash = await passwords.hashPassword(PLAIN)

    expect(hash).not.toBe(PLAIN)
    expect(hash.length).toBeGreaterThan(20)
  })

  it('salts, so the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([passwords.hashPassword(PLAIN), passwords.hashPassword(PLAIN)])

    expect(a).not.toBe(b)
  })
})

describe('verifyPassword', () => {
  it('accepts the correct password', async () => {
    const hash = await passwords.hashPassword(PLAIN)

    expect(await passwords.verifyPassword(PLAIN, hash)).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const hash = await passwords.hashPassword(PLAIN)

    expect(await passwords.verifyPassword('wrong password', hash)).toBe(false)
  })

  it('rejects an empty password', async () => {
    const hash = await passwords.hashPassword(PLAIN)

    expect(await passwords.verifyPassword('', hash)).toBe(false)
  })

  it('returns false for a malformed stored hash instead of throwing', async () => {
    // A corrupt record must fail the login, not crash the request with a 500.
    expect(await passwords.verifyPassword(PLAIN, 'not-a-hash')).toBe(false)
    expect(await passwords.verifyPassword(PLAIN, undefined)).toBe(false)
    expect(await passwords.verifyPassword(PLAIN, '')).toBe(false)
  })
})
