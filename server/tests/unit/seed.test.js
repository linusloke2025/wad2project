import { describe, it, expect } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as seed from '../../src/scripts/seed.js'

// Seed input validation.
//
// A half-seeded database is worse than an empty one: a root account with no community cannot
// log in (login requires a membership), and it looks like a broken app rather than a broken
// setup. So the input is validated before anything is written, and the failures name what is
// missing — this is the first thing a teammate runs on a fresh clone.
//
// Pure, so it needs no database.

const VALID = {
  SEED_ROOT_EMAIL: 'root@example.com',
  SEED_ROOT_PASSWORD: 'a-long-enough-password',
}

describe('readSeedInput — required values', () => {
  it('reads the required values', () => {
    const input = seed.readSeedInput(VALID)

    expect(input.rootEmail).toBe('root@example.com')
    expect(input.rootPassword).toBe('a-long-enough-password')
  })

  it('throws when the root email is missing', () => {
    expect(() => seed.readSeedInput({ SEED_ROOT_PASSWORD: VALID.SEED_ROOT_PASSWORD })).toThrow(
      /SEED_ROOT_EMAIL/,
    )
  })

  it('throws when the root password is missing', () => {
    expect(() => seed.readSeedInput({ SEED_ROOT_EMAIL: VALID.SEED_ROOT_EMAIL })).toThrow(
      /SEED_ROOT_PASSWORD/,
    )
  })

  it('names every missing variable at once', () => {
    expect(() => seed.readSeedInput({})).toThrow(
      /SEED_ROOT_EMAIL[\s\S]*SEED_ROOT_PASSWORD|SEED_ROOT_PASSWORD[\s\S]*SEED_ROOT_EMAIL/,
    )
  })

  it('rejects a malformed root email', () => {
    expect(() => seed.readSeedInput({ ...VALID, SEED_ROOT_EMAIL: 'not-an-email' })).toThrow(
      /SEED_ROOT_EMAIL/,
    )
  })

  it('rejects a root password shorter than the app minimum', () => {
    // The seeded root is subject to the same 8-character floor as any password change.
    expect(() => seed.readSeedInput({ ...VALID, SEED_ROOT_PASSWORD: 'short' })).toThrow(
      /SEED_ROOT_PASSWORD/,
    )
  })
})

describe('readSeedInput — defaults and normalisation', () => {
  it('normalises the email, so logging in cannot miss on case', () => {
    const input = seed.readSeedInput({ ...VALID, SEED_ROOT_EMAIL: '  Root@Example.COM ' })

    expect(input.rootEmail).toBe('root@example.com')
  })

  it('defaults the community name rather than creating an unnamed one', () => {
    expect(seed.readSeedInput(VALID).communityName).toBe('Default Community')
  })

  it('honours an explicit community name', () => {
    const input = seed.readSeedInput({ ...VALID, SEED_COMMUNITY_NAME: 'Orchard Parade' })

    expect(input.communityName).toBe('Orchard Parade')
  })

  it('defaults the root display name', () => {
    expect(seed.readSeedInput(VALID).rootName).toBe('Root')
  })
})

describe('readSeedInput — secrets stay out of errors', () => {
  it('never echoes the password in the error message', () => {
    let message = ''
    try {
      seed.readSeedInput({ SEED_ROOT_EMAIL: 'root@example.com', SEED_ROOT_PASSWORD: 'short' })
    } catch (error) {
      message = error.message
    }

    expect(message).toMatch(/SEED_ROOT_PASSWORD/)
    expect(message).not.toMatch(/short/)
  })
})
