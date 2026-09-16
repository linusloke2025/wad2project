import { describe, it, expect, vi } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as onemap from '../../src/services/onemapClient.js'

// OneMap token handling.
//
// Verified from OneMap's documented behaviour: tokens come from
// POST /api/auth/post/getToken with {email, password}, and the response carries both
// `access_token` and `expiry_timestamp`. The R wrapper on CRAN parses expiry_timestamp with
// as.POSIXct(as.integer(...), origin = "1970-01-01"), which is evidence it is epoch SECONDS.
//
// Credentials live only on the server. The browser never sees the OneMap email or password —
// it talks to our API, and our server talks to OneMap.
//
// UNVERIFIED ASSUMPTION: the exact JSON shape of the routing response. OneMap's docs pages are
// JS-rendered and returned empty bodies, so the field names below are modelled on the CRAN
// wrapper's summary-route output (total_time / total_dist). Confirm against the live API before
// relying on it.

const AUTH_OK = {
  access_token: 'tok-1',
  expiry_timestamp: 1772000000,
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  }
}

function makeClient({ fetchImpl, now } = {}) {
  return onemap.createOneMapClient({
    email: 'ops@example.com',
    password: 'secret',
    fetchImpl,
    now,
  })
}

describe('createOneMapClient — configuration', () => {
  it('refuses to build without credentials', () => {
    expect(() => onemap.createOneMapClient({})).toThrow()
    expect(() => onemap.createOneMapClient({ email: 'a@b.com' })).toThrow()
  })
})

describe('createOneMapClient — token caching', () => {
  it('fetches a token once and reuses it across route calls', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/auth/post/getToken')) return jsonResponse(AUTH_OK)
      return jsonResponse({ route_summary: { total_time: 600, total_distance: 800 } })
    })
    const client = makeClient({ fetchImpl, now: () => 1_000_000 })

    await client.getRouteTime({ from: [1.29, 103.85], to: [1.3, 103.86] })
    await client.getRouteTime({ from: [1.29, 103.85], to: [1.31, 103.87] })

    const authCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes('/auth/post/getToken'),
    )
    expect(authCalls).toHaveLength(1)
  })

  it('refreshes the token once it has expired', async () => {
    let clock = 1_000_000
    let issued = 0
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/auth/post/getToken')) {
        issued += 1
        // Epoch seconds, one hour ahead of the current clock.
        return jsonResponse({ access_token: `tok-${issued}`, expiry_timestamp: (clock + 3_600_000) / 1000 })
      }
      return jsonResponse({ route_summary: { total_time: 600, total_distance: 800 } })
    })
    const client = makeClient({ fetchImpl, now: () => clock })

    await client.getRouteTime({ from: [1.29, 103.85], to: [1.3, 103.86] })
    expect(issued).toBe(1)

    // Advance past expiry.
    clock += 3_700_000
    await client.getRouteTime({ from: [1.29, 103.85], to: [1.3, 103.86] })

    expect(issued).toBe(2)
  })

  it('sends the credentials only to OneMap, and only in the auth body', async () => {
    const fetchImpl = vi.fn(async (url) =>
      String(url).includes('/auth/post/getToken')
        ? jsonResponse(AUTH_OK)
        : jsonResponse({ route_summary: { total_time: 600, total_distance: 800 } }),
    )
    const client = makeClient({ fetchImpl, now: () => 1_000_000 })

    await client.getRouteTime({ from: [1.29, 103.85], to: [1.3, 103.86] })

    const authCall = fetchImpl.mock.calls.find(([url]) => String(url).includes('/auth/post/getToken'))
    expect(authCall[1].body).toContain('ops@example.com')

    const routeCall = fetchImpl.mock.calls.find(([url]) => String(url).includes('route'))
    expect(String(routeCall[0])).not.toContain('secret')
    expect(String(routeCall[1]?.body ?? '')).not.toContain('secret')
  })
})

describe('createOneMapClient — routing', () => {
  it('returns the walking duration in seconds', async () => {
    const fetchImpl = vi.fn(async (url) =>
      String(url).includes('/auth/post/getToken')
        ? jsonResponse(AUTH_OK)
        : jsonResponse({ route_summary: { total_time: 600, total_distance: 800 } }),
    )
    const client = makeClient({ fetchImpl, now: () => 1_000_000 })

    const result = await client.getRouteTime({ from: [1.29, 103.85], to: [1.3, 103.86] })

    expect(result.seconds).toBe(600)
  })

  it('throws a clear error when the routing request fails', async () => {
    const fetchImpl = vi.fn(async (url) =>
      String(url).includes('/auth/post/getToken')
        ? jsonResponse(AUTH_OK)
        : jsonResponse({ error: 'rate limited' }, { ok: false, status: 429 }),
    )
    const client = makeClient({ fetchImpl, now: () => 1_000_000 })

    await expect(client.getRouteTime({ from: [1.29, 103.85], to: [1.3, 103.86] })).rejects.toThrow()
  })

  it('throws when the auth request fails', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'bad credentials' }, { ok: false, status: 401 }))
    const client = makeClient({ fetchImpl, now: () => 1_000_000 })

    await expect(client.getRouteTime({ from: [1.29, 103.85], to: [1.3, 103.86] })).rejects.toThrow()
  })
})
