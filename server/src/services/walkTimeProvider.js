/**
 * Walk-time provider — the seam that makes acceptance criterion 5 real.
 *
 * A travel time is either ROUTED (a real OneMap route) or ESTIMATED (straight-line distance on
 * the layout). The two must never be confused: a planner judging whether a transition is
 * feasible needs to know whether the number is measured or guessed, and the conflict engine
 * carries `source` through to the UI for exactly that reason.
 *
 *   map  mode -> zones carry real coordinates, so OneMap routing applies.
 *   plan mode -> zones are image pixels, so distance x metresPerPixel / walking speed. OneMap
 *                is never called, because pixel distance is meaningless as lat/lng.
 *
 * Either mode falls back to an estimate when routing fails, still labelled `estimate`.
 *
 * Caching is by unordered zone pair. This is what keeps OneMap calls off the keystroke path,
 * since conflicts recompute on every assignment create/edit (docs/SPEC.md section 6).
 */

const DEFAULT_WALKING_SPEED_MPS = 1.4
const DEFAULT_METRES_PER_PIXEL = 1

function lookupZone(zones, zoneId) {
  if (zones instanceof Map) return zones.get(zoneId)
  return zones?.[zoneId]
}

/**
 * @param {{mode: 'map'|'plan', zones: object|Map, client?: object,
 *          metresPerPixel?: number, walkingSpeedMps?: number}} config
 * @returns {{getWalkTime: (fromZoneId: string, toZoneId: string) => Promise<{seconds: number, source: 'onemap'|'estimate'}>}}
 */
export function createWalkTimeProvider({
  mode,
  zones = {},
  client,
  metresPerPixel = DEFAULT_METRES_PER_PIXEL,
  walkingSpeedMps = DEFAULT_WALKING_SPEED_MPS,
} = {}) {
  if (mode !== 'map' && mode !== 'plan') {
    throw new Error("createWalkTimeProvider requires mode to be 'map' or 'plan'")
  }

  const cache = new Map()

  function centroidOf(zoneId) {
    const zone = lookupZone(zones, zoneId)
    if (!zone?.centroid) {
      // Guessing a distance for an unknown zone would silently under- or over-report conflicts.
      throw new Error(`Unknown zone: ${zoneId}`)
    }
    return zone.centroid
  }

  function estimateSeconds(fromCentroid, toCentroid) {
    const metres = Math.hypot(
      fromCentroid[0] - toCentroid[0],
      fromCentroid[1] - toCentroid[1],
    ) * metresPerPixel
    return metres / walkingSpeedMps
  }

  async function getWalkTime(fromZoneId, toZoneId) {
    const key = [fromZoneId, toZoneId].sort().join('|')

    const cached = cache.get(key)
    if (cached) return cached

    const fromCentroid = centroidOf(fromZoneId)
    const toCentroid = centroidOf(toZoneId)

    if (mode === 'map' && client) {
      try {
        const routed = await client.getRouteTime({ from: fromCentroid, to: toCentroid })
        const result = { seconds: routed.seconds, source: 'onemap' }
        cache.set(key, result)
        return result
      } catch {
        // Deliberately NOT cached: a transient OneMap failure must not freeze a guess into
        // place for the rest of the session. The next call retries and may upgrade to a route.
        return {
          seconds: estimateSeconds(fromCentroid, toCentroid),
          source: 'estimate',
        }
      }
    }

    const result = {
      seconds: estimateSeconds(fromCentroid, toCentroid),
      source: 'estimate',
    }
    cache.set(key, result)
    return result
  }

  return { getWalkTime }
}
