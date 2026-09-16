/**
 * Wires stored event data into the pure conflict engine.
 *
 * The engine itself knows nothing about databases, HTTP, or OneMap — it takes plain arrays and
 * an injected walk-time function. This service is the adapter: it turns an event's zones into
 * geometry the engine can use, decides whether the event routes for real (Map layout) or
 * estimates (Plan layout), and runs all four rules.
 *
 * The walk-time provider is built per evaluation, not once at startup, because it depends on
 * the event's own zones and layout mode.
 */

import { detectConflicts } from '../domain/conflicts.js'
import { polygonCentroid } from '../domain/geometry.js'
import { createWalkTimeProvider } from './walkTimeProvider.js'

const DEFAULT_WALKING_SPEED_MPS = 1.4
const DEFAULT_METRES_PER_PIXEL = 1

export function createConflictService({ onemapClient = null } = {}) {
  /**
   * @param {{event: object, zones?: Array, groups?: Array, assignments?: Array}} input
   * @returns {Promise<{conflicts: Array, unresolvedCount: number}>}
   */
  async function evaluate({ event, zones = [], groups = [], assignments = [] }) {
    const zoneMap = {}
    for (const zone of zones) {
      if (!Array.isArray(zone.polygon)) continue
      zoneMap[zone.id] = {
        id: zone.id,
        polygon: zone.polygon,
        centroid: polygonCentroid(zone.polygon),
      }
    }

    // A zone the designer marked blocked is what rule 3 checks assignments against.
    const blockedAreas = zones
      .filter((zone) => zone.kind === 'blocked' && Array.isArray(zone.polygon))
      .map((zone) => ({ id: zone.id, polygon: zone.polygon }))

    const walkTimeProvider = createWalkTimeProvider({
      // Map layouts carry real coordinates, so routes are real. Plan layouts are image pixels,
      // where routing would be meaningless — those estimate against the pixel-to-metre scale.
      mode: event.layoutMode === 'map' ? 'map' : 'plan',
      zones: zoneMap,
      client: onemapClient,
      metresPerPixel: event.metresPerPixel ?? DEFAULT_METRES_PER_PIXEL,
      walkingSpeedMps: event.walkingSpeedMps ?? DEFAULT_WALKING_SPEED_MPS,
    })

    // An itinerary can outlive the zone it points at: a designer may delete a zone while
    // assignments still reference it. The transition rule asks for a walk time between zones
    // and would throw on one that no longer exists, taking the entire conflict list down with
    // it — so the planner would see an error instead of every other real problem on the plan.
    // Dropping the orphans keeps the rest of the evaluation useful.
    const knownAssignments = assignments.filter((assignment) => zoneMap[assignment.zoneId])

    const conflicts = await detectConflicts(knownAssignments, {
      getWalkTime: walkTimeProvider.getWalkTime,
      zones: zoneMap,
      blockedAreas,
      groups,
      eventWindow: { start: event.start, end: event.end },
    })

    // The planner's UI badges this count, so it is computed once here rather than in the client.
    return { conflicts, unresolvedCount: conflicts.length }
  }

  return { evaluate }
}
