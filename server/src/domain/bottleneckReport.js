/**
 * The post-event bottleneck report.
 *
 * This is the app's answer to "there is no way to find out where the bottlenecks were", so the
 * numbers have to mean something specific rather than merely be present:
 *
 *   planned dwell — how long the plan said a zone would be occupied
 *   actual dwell  — how long it really was, measured from what the leads reported
 *   overrun       — the difference, which is the bottleneck worth acting on next time
 *
 * Actual dwell is derived from status history rather than from anything new. A group occupies a
 * zone from the moment its lead reports `arrived` until it reports anything else, and the zone is
 * the one whose assignment window contains that arrival — falling back to the most recent
 * assignment that had already started, because a group that arrives late is still in the zone it
 * was sent to. That deliberately reuses data the leads already produce, so the report costs
 * nobody extra work during the event.
 *
 * A zone nobody reported on is marked `measured: false` and its overrun is null, not zero. Zero
 * would read as "we hit the plan exactly", which is the opposite of "we have no idea".
 *
 * Pure: no database, socket or clock.
 */

const MS_PER_SECOND = 1000

function secondsBetween(fromMs, toMs) {
  return Math.round((toMs - fromMs) / MS_PER_SECOND)
}

function groupBy(items, key) {
  const map = new Map()
  for (const item of items) {
    const bucket = map.get(item[key])
    if (bucket) bucket.push(item)
    else map.set(item[key], [item])
  }
  return map
}

/**
 * @param {{
 *   zones?: Array<{id: string, name?: string}>,
 *   groups?: Array<{id: string}>,
 *   assignments?: Array<{id: string, groupId: string, zoneId: string, start: string, end: string}>,
 *   statusUpdates?: Array<{groupId: string, status: string, at: string}>,
 *   conflicts?: Array<object>,
 *   assignmentZone?: Record<string, string>,
 *   eventWindow?: {start: string, end: string},
 * }} input
 */
export function buildBottleneckReport({
  zones = [],
  groups = [],
  assignments = [],
  statusUpdates = [],
  conflicts = [],
  assignmentZone = {},
  eventWindow,
} = {}) {
  const eventEndMs = eventWindow?.end ? Date.parse(eventWindow.end) : null

  const assignmentsByGroup = groupBy(assignments, 'groupId')
  for (const bucket of assignmentsByGroup.values()) {
    bucket.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
  }

  const assignmentsByZone = groupBy(assignments, 'zoneId')

  const updatesByGroup = groupBy(statusUpdates, 'groupId')
  for (const bucket of updatesByGroup.values()) {
    bucket.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  }

  /** The zone a group was in when it reported arriving. */
  function zoneForArrival(groupId, atMs) {
    const bucket = assignmentsByGroup.get(groupId) ?? []

    const containing = bucket.find(
      (assignment) => Date.parse(assignment.start) <= atMs && atMs < Date.parse(assignment.end),
    )
    if (containing) return containing.zoneId

    // Late arrivals: attribute to the most recent assignment that had already begun.
    const started = bucket.filter((assignment) => Date.parse(assignment.start) <= atMs)
    if (started.length > 0) return started[started.length - 1].zoneId

    return bucket[0]?.zoneId ?? null
  }

  const actualByZone = new Map()
  const measuredZones = new Set()

  for (const [groupId, updates] of updatesByGroup) {
    for (let index = 0; index < updates.length; index += 1) {
      const update = updates[index]
      if (update.status !== 'arrived') continue

      const arrivedAt = Date.parse(update.at)
      // The next report of anything else is the departure. Nothing else means the group was
      // still there at the end — a finding, not missing data.
      const next = updates.slice(index + 1).find((candidate) => candidate.status !== 'arrived')
      const leftAt = next ? Date.parse(next.at) : eventEndMs

      if (Number.isNaN(arrivedAt) || leftAt === null || Number.isNaN(leftAt) || leftAt <= arrivedAt) {
        continue
      }

      const zoneId = zoneForArrival(groupId, arrivedAt)
      if (!zoneId) continue

      actualByZone.set(zoneId, (actualByZone.get(zoneId) ?? 0) + secondsBetween(arrivedAt, leftAt))
      measuredZones.add(zoneId)
    }
  }

  const overlapByZone = new Map()
  const tightByZone = new Map()
  for (const conflict of conflicts) {
    if (conflict.type === 'zone_double_booking' && conflict.zoneId) {
      overlapByZone.set(conflict.zoneId, (overlapByZone.get(conflict.zoneId) ?? 0) + 1)
    }
    // A tight transition is a problem with arriving at the zone being walked *to*.
    if (conflict.type === 'tight_transition' && conflict.toAssignmentId) {
      const zoneId = assignmentZone[conflict.toAssignmentId]
      if (zoneId) tightByZone.set(zoneId, (tightByZone.get(zoneId) ?? 0) + 1)
    }
  }

  const rows = zones.map((zone) => {
    const planned = (assignmentsByZone.get(zone.id) ?? []).reduce(
      (sum, assignment) => sum + secondsBetween(Date.parse(assignment.start), Date.parse(assignment.end)),
      0,
    )
    const actual = actualByZone.get(zone.id) ?? 0
    const measured = measuredZones.has(zone.id)

    return {
      zoneId: zone.id,
      zoneName: zone.name ?? zone.id,
      plannedDwellSeconds: planned,
      actualDwellSeconds: actual,
      overrunSeconds: measured ? actual - planned : null,
      measured,
      overlapCount: overlapByZone.get(zone.id) ?? 0,
      tightTransitionCount: tightByZone.get(zone.id) ?? 0,
    }
  })

  // Lead with the problem: the busiest zone first.
  rows.sort((a, b) => b.actualDwellSeconds - a.actualDwellSeconds)

  return {
    zones: rows,
    totals: {
      plannedDwellSeconds: rows.reduce((sum, row) => sum + row.plannedDwellSeconds, 0),
      actualDwellSeconds: rows.reduce((sum, row) => sum + row.actualDwellSeconds, 0),
      measuredZoneCount: rows.filter((row) => row.measured).length,
      zoneCount: rows.length,
      groupCount: groups.length,
    },
  }
}
