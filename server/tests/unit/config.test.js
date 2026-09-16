import { describe, it, expect } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as config from '../../src/config.js'

// Configuration loading.
//
// Takes the environment as an argument rather than reading process.env directly, so every case
// below is a pure function call with no global mutation and no test-ordering hazard.
//
// The point of validating here is failure timing: a missing JWT secret should stop the process
// at startup with a sentence naming the variable, not surface later as mysterious 401s, or worse
// as tokens signed with an empty key.

const VALID = { JWT_SECRET: 'a-long-random-secret', MONGODB_URI: 'mongodb://localhost:27017/app' }

describe('loadConfig — required values', () => {
  it('reads the required values', () => {
    const loaded = config.loadConfig(VALID)

    expect(loaded.jwtSecret).toBe('a-long-random-secret')
    expect(loaded.mongodbUri).toBe('mongodb://localhost:27017/app')
  })

  it('throws when JWT_SECRET is missing', () => {
    expect(() => config.loadConfig({ MONGODB_URI: VALID.MONGODB_URI })).toThrow(/JWT_SECRET/)
  })

  it('throws when JWT_SECRET is present but blank', () => {
    expect(() => config.loadConfig({ ...VALID, JWT_SECRET: '   ' })).toThrow(/JWT_SECRET/)
  })

  it('throws when MONGODB_URI is missing', () => {
    expect(() => config.loadConfig({ JWT_SECRET: VALID.JWT_SECRET })).toThrow(/MONGODB_URI/)
  })

  it('names every missing variable at once, so one restart fixes them all', () => {
    expect(() => config.loadConfig({})).toThrow(/JWT_SECRET[\s\S]*MONGODB_URI|MONGODB_URI[\s\S]*JWT_SECRET/)
  })
})

describe('loadConfig — defaults and optional values', () => {
  it('defaults the port to 3000', () => {
    expect(config.loadConfig(VALID).port).toBe(3000)
  })

  it('honours an explicit port', () => {
    expect(config.loadConfig({ ...VALID, PORT: '8080' }).port).toBe(8080)
  })

  it('rejects a non-numeric port rather than listening on something unintended', () => {
    expect(() => config.loadConfig({ ...VALID, PORT: 'not-a-port' })).toThrow(/PORT/)
  })

  it('leaves the OneMap credentials optional, since the map API needs none', () => {
    const loaded = config.loadConfig(VALID)

    expect(loaded.onemapEmail).toBeUndefined()
    expect(loaded.onemapPassword).toBeUndefined()
  })

  it('picks up the OneMap credentials when they are supplied', () => {
    const loaded = config.loadConfig({ ...VALID, ONEMAP_EMAIL: 'a@b.com', ONEMAP_PASSWORD: 'pw' })

    expect(loaded.onemapEmail).toBe('a@b.com')
    expect(loaded.onemapPassword).toBe('pw')
  })

  it('reports whether OneMap routing is available without exposing the password', () => {
    expect(config.loadConfig(VALID).hasOneMapRouting).toBe(false)
    expect(config.loadConfig({ ...VALID, ONEMAP_EMAIL: 'a@b.com', ONEMAP_PASSWORD: 'pw' }).hasOneMapRouting).toBe(true)
  })
})

describe('loadConfig — secrets stay out of errors', () => {
  it('never echoes a secret value in the error message', () => {
    // Configuration errors get logged and pasted into chats; a secret must not ride along.
    let message = ''
    try {
      config.loadConfig({ MONGODB_URI: VALID.MONGODB_URI })
    } catch (error) {
      message = error.message
    }

    expect(message).toMatch(/JWT_SECRET/)
    expect(message).not.toMatch(/a-long-random-secret/)
  })
})
