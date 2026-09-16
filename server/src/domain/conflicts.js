/**
 * Conflict engine — detects planning conflicts in a group's itinerary.
 *
 * A conflict is advisory: it never blocks an event from going live. The planner sees
 * unresolved conflicts inline (see docs/SPEC.md section 6).
 *
 * Time windows are half-open, `[start, end)`. A slot that ends exactly when the next begins
 * is adjacent, not overlapping, so it is NOT a conflict. This matters because event
 * schedules routinely chain slots back to back.
 */

import { polygonCentroid, polygonsIntersect, segmentIntersectsPolygon } from './geometry.js'

/** @returns {[number, number]} epoch-millisecond interval for an assignment */
function intervalOf(assignment) {
  return [Date.parse(assignment.start), Date.parse(assignment.end)]
}

/** Half-open interval overlap: touching endpoints do not count. */
function overlaps(a, b) {
  const [aStart, aEnd] = intervalOf(a)
  const [bStart, bEnd] = intervalOf(b)
  return aStart < bEnd && bStart < aEnd
}

/**
 * Rule 1 — zone double-booking.
 *
 * Two *different* groups may not hold the same zone at overlapping times. A group overlapping
 * itself in one zone is its own itinerary's problem, not a double-booking, so it is ignored.
 *
 * @param {Array<{id: string, groupId: string, zoneId: string, start: string, end: string}>} assignments
 * @returns {Array<{type: string, zoneId: string, assignmentIds: string[]}>}
 */
export function detectZoneDoubleBooking(assignments = []) {
  const conflicts = []

  for (let i = 0; i < assignments.length; i += 1) {
    for (let j = i + 1; j < assignments.length; j += 1) {
      const a = assignments[i]
      const b = assignments[j]

      if (a.zoneId !== b.zoneId) continue
      if (a.groupId === b.groupId) continue
      if (!overlaps(a, b)) continue

      conflicts.push({
        type: 'zone_double_booking',
        zoneId: a.zoneId,
        assignmentIds: [a.id, b.id],
      })
    }
  }

  return conflicts
}

/**
 * Rule 2 — tight transition.
 *
 * For each group's itinerary in chronological order, a transition is tight when the gap
 * between the end of one slot and the start of the next is shorter than the walking time
 * between those two zones.
 *
 * The walking time is injected rather than fetched here, for two reasons:
 *   - the rule stays unit-testable with no network and no OneMap credentials;
 *   - the `source` ('onemap' vs 'estimate') travels with the conflict, so a scaled
 *     straight-line estimate is never displayed as a real routed time. That distinction is
 *     acceptance criterion 5: Map layout mode routes for real, Plan layout mode estimates.
 *
 * @param {Array<{id: string, groupId: string, zoneId: string, start: string, end: string}>} assignments
 * @param {{getWalkTime: (fromZoneId: string, toZoneId: string) => Promise<{seconds: number, source: string}>}} providers
 * @returns {Promise<Array<{type: string, groupId: string, fromAssignmentId: string, toAssignmentId: string, gapSeconds: number, walkSeconds: number, source: string}>>}
 */
export async function detectTightTransitions(assignments = [], { getWalkTime } = {}) {
  if (typeof getWalkTime !== 'function') {
    throw new TypeError('detectTightTransitions requires a getWalkTime provider')
  }

  const byGroup = new Map()
  for (const assignment of assignments) {
    if (!byGroup.has(assignment.groupId)) byGroup.set(assignment.groupId, [])
    byGroup.get(assignment.groupId).push(assignment)
  }

  const conflicts = []

  for (const [groupId, slots] of byGroup) {
    // Sort defensively: input order is not guaranteed, and a mis-sorted itinerary would
    // silently compare the wrong pairs.
    const ordered = [...slots].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))

    for (let i = 0; i + 1 < ordered.length; i += 1) {
      const from = ordered[i]
      const to = ordered[i + 1]

      const gapSeconds = Math.round((Date.parse(to.start) - Date.parse(from.end)) / 1000)
      const { seconds: walkSeconds, source } = await getWalkTime(from.zoneId, to.zoneId)

      if (gapSeconds < walkSeconds) {
        conflicts.push({
          type: 'tight_transition',
          groupId,
          fromAssignmentId: from.id,
          toAssignmentId: to.id,
          gapSeconds,
          walkSeconds,
          source,
        })
      }
    }
  }

  return conflicts
}

/** Resolve a zone by id from either a plain object map or a Map. */
function lookupZone(zones, zoneId) {
  if (zones instanceof Map) return zones.get(zoneId)
  return zones?.[zoneId]
}

/**
 * Rule 3 — blocked-area violation.
 *
 * Two ways a blocked area is violated:
 *   - 'occupied': the group's zone polygon overlaps a blocked polygon.
 *   - 'transit' : the straight path between two consecutive zones crosses a blocked polygon.
 *
 * This is what makes the layout designer role part of the core logic rather than decoration:
 * the areas they mark feed straight into the planner's conflict list.
 *
 * Unknown zones are skipped rather than throwing — a zone can be deleted while an itinerary
 * still references it, and that must not take down conflict computation for the whole event.
 *
 * @param {Array<object>} assignments
 * @param {{zones: object|Map, blockedAreas: Array<{id: string, polygon: number[][]}>}} context
 * @returns {Array<object>}
 */
export function detectBlockedAreaViolations(assignments = [], { zones = {}, blockedAreas = [] } = {}) {
  const conflicts = []
  const reported = new Set()

  for (const assignment of assignments) {
    const zone = lookupZone(zones, assignment.zoneId)
    if (!zone?.polygon) continue

    for (const blocked of blockedAreas) {
      if (!blocked?.polygon) continue
      if (!polygonsIntersect(zone.polygon, blocked.polygon)) continue

      const key = `${assignment.id}:${blocked.id}`
      if (reported.has(key)) continue
      reported.add(key)

      conflicts.push({
        type: 'blocked_area',
        kind: 'occupied',
        groupId: assignment.groupId,
        assignmentId: assignment.id,
        zoneId: assignment.zoneId,
        blockedAreaId: blocked.id,
      })
    }
  }

  const byGroup = new Map()
  for (const assignment of assignments) {
    if (!byGroup.has(assignment.groupId)) byGroup.set(assignment.groupId, [])
    byGroup.get(assignment.groupId).push(assignment)
  }

  for (const [groupId, slots] of byGroup) {
    const ordered = [...slots].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))

    for (let i = 0; i + 1 < ordered.length; i += 1) {
      const from = ordered[i]
      const to = ordered[i + 1]

      const fromCentroid = polygonCentroid(lookupZone(zones, from.zoneId)?.polygon)
      const toCentroid = polygonCentroid(lookupZone(zones, to.zoneId)?.polygon)
      if (!fromCentroid || !toCentroid) continue

      for (const blocked of blockedAreas) {
        if (!blocked?.polygon) continue
        if (!segmentIntersectsPolygon(fromCentroid, toCentroid, blocked.polygon)) continue

        conflicts.push({
          type: 'blocked_area',
          kind: 'transit',
          groupId,
          fromAssignmentId: from.id,
          toAssignmentId: to.id,
          blockedAreaId: blocked.id,
        })
      }
    }
  }

  return conflicts
}

/**
 * Rule 4 — unscheduled group.
 *
 * A group is unscheduled when it holds no assignment overlapping the event window: either no
 * assignments at all, or only slots that fall outside it. This is the gap that leaves a group
 * waiting with nobody telling it when to move — the exact failure the app exists to prevent.
 *
 * Overlap is half-open, matching the rest of the engine, so a slot running right up to the
 * window opening still counts as scheduled.
 *
 * @param {Array<{id: string}>} groups
 * @param {Array<object>} assignments
 * @param {{eventWindow: {start: string, end: string}}} context
 * @returns {Array<{type: string, groupId: string}>}
 */
export function detectUnscheduledGroups(groups = [], assignments = [], { eventWindow } = {}) {
  if (!eventWindow) {
    throw new TypeError('detectUnscheduledGroups requires an eventWindow')
  }

  const windowStart = Date.parse(eventWindow.start)
  const windowEnd = Date.parse(eventWindow.end)

  const unscheduled = []

  for (const group of groups) {
    const holdsSlotInWindow = assignments.some(
      (assignment) =>
        assignment.groupId === group.id &&
        Date.parse(assignment.start) < windowEnd &&
        windowStart < Date.parse(assignment.end),
    )

    if (!holdsSlotInWindow) {
      unscheduled.push({ type: 'unscheduled_group', groupId: group.id })
    }
  }

  return unscheduled
}

/**
 * Run every conflict rule over a plan and return one combined list.
 *
 * Required providers throw when missing rather than causing a rule to be skipped: silently
 * omitting a rule would under-report conflicts, and a planner seeing "no conflicts" when the
 * engine never actually checked is worse than a loud failure.
 *
 * @param {Array<object>} assignments
 * @param {{getWalkTime: Function, zones?: object|Map, blockedAreas?: Array, groups?: Array, eventWindow: {start: string, end: string}}} context
 * @returns {Promise<Array<object>>}
 */
export async function detectConflicts(assignments = [], context = {}) {
  const { getWalkTime, zones = {}, blockedAreas = [], groups = [], eventWindow } = context

  if (typeof getWalkTime !== 'function') {
    throw new TypeError('detectConflicts requires a getWalkTime provider')
  }
  if (!eventWindow) {
    throw new TypeError('detectConflicts requires an eventWindow')
  }

  const zoneDoubleBookings = detectZoneDoubleBooking(assignments)
  const tightTransitions = await detectTightTransitions(assignments, { getWalkTime })
  const blockedAreaViolations = detectBlockedAreaViolations(assignments, { zones, blockedAreas })
  const unscheduledGroups = detectUnscheduledGroups(groups, assignments, { eventWindow })

  return [
    ...zoneDoubleBookings,
    ...tightTransitions,
    ...blockedAreaViolations,
    ...unscheduledGroups,
  ]
}
