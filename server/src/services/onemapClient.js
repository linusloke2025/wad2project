/**
 * OneMap (Singapore Land Authority) client — server-side only.
 *
 * Credentials never leave the server: the browser talks to our API, and our server talks to
 * OneMap. This module owns the access token so the rest of the app never sees it.
 *
 * Verified from OneMap's documented behaviour: tokens come from
 * POST /api/auth/post/getToken with `{email, password}`, and the response carries
 * `access_token` plus `expiry_timestamp`. The CRAN `onemapsgapi` wrapper parses
 * `expiry_timestamp` via `as.POSIXct(as.integer(...), origin="1970-01-01")`, which is evidence
 * it is epoch SECONDS — so it is treated as such here rather than guessed as ISO.
 *
 * UNVERIFIED (confirm against the live API before relying on it):
 *   - the exact routing endpoint path, and
 *   - the routing response shape. OneMap's docs pages are JS-rendered and returned empty
 *     bodies, so the parsing below models the wrapper's summary-route output
 *     (`route_summary.total_time` / `total_distance`) and the units (seconds / metres).
 * Both are isolated here so a correction is a one-file change.
 */

const DEFAULT_BASE_URL = 'https://www.onemap.gov.sg'

export function createOneMapClient({
  email,
  password,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  if (!email || !password) {
    throw new Error('createOneMapClient requires email and password')
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('createOneMapClient requires a fetch implementation')
  }

  let token = null
  let expiresAtMs = 0

  async function fetchToken() {
    const response = await fetchImpl(`${baseUrl}/api/auth/post/getToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

    if (!response.ok) {
      throw new Error(`OneMap authentication failed with status ${response.status}`)
    }

    const body = await response.json()
    if (!body?.access_token) {
      throw new Error('OneMap authentication returned no access_token')
    }

    token = body.access_token
    // epoch seconds -> milliseconds
    expiresAtMs = Number(body.expiry_timestamp) * 1000
    return token
  }

  async function getToken() {
    if (token && now() < expiresAtMs) return token
    return fetchToken()
  }

  /**
   * @param {{from: [number, number], to: [number, number], mode?: 'walk'|'drive'|'cycle'|'pt'}} params
   * @returns {Promise<{seconds: number, distanceMetres: number|null}>}
   */
  async function getRouteTime({ from, to, mode = 'walk' }) {
    const accessToken = await getToken()

    const url =
      `${baseUrl}/api/public/routingsvc/route` +
      `?start=${from[0]},${from[1]}&end=${to[0]},${to[1]}&routeType=${mode}`

    const response = await fetchImpl(url, {
      headers: { Authorization: accessToken },
    })

    if (!response.ok) {
      throw new Error(`OneMap routing failed with status ${response.status}`)
    }

    const body = await response.json()
    const seconds = body?.route_summary?.total_time

    if (typeof seconds !== 'number') {
      throw new Error('OneMap routing returned no total_time')
    }

    return {
      seconds,
      distanceMetres: body?.route_summary?.total_distance ?? null,
    }
  }

  return { getToken, getRouteTime }
}
