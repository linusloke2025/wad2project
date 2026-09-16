import { describe, it, expect } from 'vitest'
import dotenv from 'dotenv'

import { createOneMapClient } from '../../src/services/onemapClient.js'

// LIVE integration test against the real OneMap API.
//
// This is the only test that talks to the network. It exists because the routing endpoint's
// path, response shape and units were assumed for several rounds before real credentials became
// available — an assumption that would have failed silently at exactly the wrong moment, since
// walkTimeProvider treats any routing error as "fall back to an estimate". A wrong field name
// would not throw; it would quietly downgrade every Map-layout walk time to a straight-line
// guess while still looking healthy.
//
// It SKIPS when credentials are absent, so a fresh clone and any CI run without secrets stay
// green. Run it deliberately with server/.env populated:
//
//   npm run test:unit -- tests/live
//
// Its assertions are deliberately loose about the numbers (routes change with traffic and one
// day's geometry is not another's) and strict about the shape: the point is that OneMap still
// answers in the form the client parses.

dotenv.config()

const EMAIL = process.env.ONEMAP_EMAIL
const PASSWORD = process.env.ONEMAP_PASSWORD
const hasCredentials = Boolean(EMAIL && PASSWORD)

// Two points a short walk apart in central Singapore.
const FROM = [1.31955, 103.84223]
const TO = [1.3205, 103.8435]

describe.skipIf(!hasCredentials)('OneMap live routing', () => {
  it('returns a walking duration and distance for a real route', async () => {
    const client = createOneMapClient({ email: EMAIL, password: PASSWORD })

    const route = await client.getRouteTime({ from: FROM, to: TO })

    // Shape: numbers, in the units the conflict engine assumes.
    expect(typeof route.seconds).toBe('number')
    expect(route.seconds).toBeGreaterThan(0)
    // A walk this short should not take an hour; a unit mix-up (ms, minutes) would blow this.
    expect(route.seconds).toBeLessThan(3600)

    expect(typeof route.distanceMetres).toBe('number')
    expect(route.distanceMetres).toBeGreaterThan(0)
  }, 30000)

  it('caches the access token rather than re-authenticating on every call', async () => {
    const client = createOneMapClient({ email: EMAIL, password: PASSWORD })

    const first = await client.getToken()
    const second = await client.getToken()

    expect(second).toBe(first)
  }, 30000)
})

describe.skipIf(hasCredentials)('OneMap live routing (skipped)', () => {
  it('explains why the live checks did not run', () => {
    // Visible in the run output so nobody mistakes a skip for a pass.
    expect(hasCredentials).toBe(false)
    console.log('[live] ONEMAP_EMAIL / ONEMAP_PASSWORD not set — live OneMap checks skipped')
  })
})
