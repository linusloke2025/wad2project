/**
 * OneMap (Singapore Land Authority) client — server-side only.
 *
 * Credentials never leave the server: the browser talks to our API, and our server talks to
 * OneMap. This module owns the access token so the rest of the app never sees it.
 *
 * Auth is VERIFIED against the live API: POST /api/auth/post/getToken with `{email, password}`
 * returns `access_token` plus `expiry_timestamp`. Inspecting a live token showed a 72.0 hour
 * lifetime with `expiry_timestamp` equal to the JWT's own `exp`, confirming it is epoch SECONDS
 * — so it is treated as such here rather than guessed as ISO.
 *
 * Routing is VERIFIED against the live API too. GET /api/public/routingsvc/route with
 * `start=lat,lng&end=lat,lng&routeType=walk` and the raw token in the `Authorization` header
 * (no "Bearer" prefix) returns:
 *
 *   { status_message, route_geometry, status, route_instructions, route_name,
 *     route_summary: { start_point, end_point, total_time: 164, total_distance: 227 } }
 *
 * So the field path below is correct, and the units are seconds and metres. A 227m walk taking
 * 164s works out at ~1.38 m/s, consistent with walking pace.
 *
 * NOT verified: documented rate limits. OneMap's docs pages are JS-rendered and returned empty
 * bodies, so no numeric limit could be confirmed. Route results are cached by zone pair upstream
 * in walkTimeProvider, which is what keeps call volume off the keystroke path.
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
