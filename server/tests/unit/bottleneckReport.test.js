import { describe, it, expect } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as report from '../../src/domain/bottleneckReport.js'

/**
 * The post-event bottleneck report.
 *
 * This is the app's answer to "there is no way to find out where the bottlenecks were", so the
 * numbers have to mean something specific rather than merely be present:
 *
 *   planned dwell  — how long the plan said a zone would be occupied
 *   actual dwell   — how long it really was, measured from status reports
 *   overrun        — the difference, which is the bottleneck
 *
 * Actual dwell is derived from status history rather than from anything separate. A group is
 * considered to occupy a zone from the moment its lead reports `arrived` until it reports
 * anything else; the zone is the one whose assignment window contains that arrival. That
 * deliberately reuses data the leads already produce, so the report costs nobody extra work.
 *
 * Pure, so no database, socket or clock is involved.
 */

const T = (hhmm) => `2026-03-01T${hhmm}:00+08:00`
const WINDOW = { start: T('09:00'), end: T('12:00') }

const ZONES = [
  { id: 'z1', name: 'Main Stage' },
  { id: 'z2', name: 'Holding Area' },
]

const GROUPS = [{ id: 'g1', name: 'Group A' }, { id: 'g2', name: 'Group B' }]

const assign = (id, groupId, zoneId, start, end) => ({ id, groupId, zoneId, start, end })
const status = (groupId, value, at) => ({ groupId, status: value, at })

describe('planned dwell', () => {
  it('sums the assigned windows per zone', () => {
    const built = report.buildBottleneckReport({
      zones: ZONES,
      groups: GROUPS,
      assignments: [assign('a1', 'g1', 'z1', T('09:00'), T('09:30')), assign('a2', 'g2', 'z1', T('10:00'), T('10:15'))],
      statusUpdates: [],
      eventWindow: WINDOW,
    })

    const stage = built.zones.find((zone) => zone.zoneId === 'z1')
    // 30 minutes + 15 minutes
    expect(stage.plannedDwellSeconds).toBe((30 + 15) * 60)
  })

  it('reports zero planned dwell for a zone nothing is scheduled in', () => {
    const built = report.buildBottleneckReport({
      zones: ZONES,
      groups: GROUPS,
      assignments: [assign('a1', 'g1', 'z1', T('09:00'), T('09:30'))],
      statusUpdates: [],
      eventWindow: WINDOW,
    })

    expect(built.zones.find((zone) => zone.zoneId === 'z2').plannedDwellSeconds).toBe(0)
  })
})

describe('actual dwell from status history', () => {
  it('measures from arrived to the next different report and attributes it to the planned zone', () => {
    const built = report.buildBottleneckReport({
      zones: ZONES,
      groups: GROUPS,
      assignments: [assign('a1', 'g1', 'z1', T('09:00'), T('09:30'))],
      statusUpdates: [status('g1', 'arrived', T('09:05')), status('g1', 'moving', T('09:40'))],
      eventWindow: WINDOW,
    })

    // 09:05 -> 09:40 is 35 minutes, against 30 planned: a five minute overrun.
    const stage = built.zones.find((zone) => zone.zoneId === 'z1')
    expect(stage.actualDwellSeconds).toBe(35 * 60)
    expect(stage.overrunSeconds).toBe(5 * 60)
  })

  it('runs an arrival with no departure to the event end, rather than treating it as zero', () => {
    // A group that arrives and is never heard from again is a finding, not missing data.
    const built = report.buildBottleneckReport({
      zones: ZONES,
      groups: GROUPS,
      assignments: [assign('a1', 'g1', 'z1', T('09:00'), T('09:30'))],
      statusUpdates: [status('g1', 'arrived', T('11:00'))],
      eventWindow: WINDOW,
    })

    const stage = built.zones.find((zone) => zone.zoneId === 'z1')
    expect(stage.actualDwellSeconds).toBe(60 * 60)
  })

  it('attributes an arrival to the zone whose window contains it, not to the group', () => {
    // Group A moves between two zones; each arrival must land on the right one.
    const built = report.buildBottleneckReport({
      zones: ZONES,
      groups: GROUPS,
      assignments: [
        assign('a1', 'g1', 'z1', T('09:00'), T('09:30')),
        assign('a2', 'g1', 'z2', T('10:00'), T('10:30')),
      ],
      statusUpdates: [
        status('g1', 'arrived', T('09:05')),
        status('g1', 'moving', T('09:25')),
        status('g1', 'arrived', T('10:02')),
        status('g1', 'moving', T('10:12')),
      ],
      eventWindow: WINDOW,
    })

    expect(built.zones.find((zone) => zone.zoneId === 'z1').actualDwellSeconds).toBe(20 * 60)
    expect(built.zones.find((zone) => zone.zoneId === 'z2').actualDwellSeconds).toBe(10 * 60)
  })

  it('reports no measurement rather than a misleading zero when nobody reported', () => {
    const built = report.buildBottleneckReport({
      zones: ZONES,
      groups: GROUPS,
      assignments: [assign('a1', 'g1', 'z1', T('09:00'), T('09:30'))],
      statusUpdates: [],
      eventWindow: WINDOW,
    })

    const stage = built.zones.find((zone) => zone.zoneId === 'z1')
    expect(stage.actualDwellSeconds).toBe(0)
    expect(stage.measured).toBe(false)
  })

  it('marks a zone as measured once any group reports there', () => {
    const built = report.buildBottleneckReport({
      zones: ZONES,
      groups: GROUPS,
      assignments: [assign('a1', 'g1', 'z1', T('09:00'), T('09:30'))],
      statusUpdates: [status('g1', 'arrived', T('09:05')), status('g1', 'moving', T('09:20'))],
      eventWindow: WINDOW,
    })

    expect(built.zones.find((zone) => zone.zoneId === 'z1').measured).toBe(true)
  })
})

describe('conflicts folded into the report', () => {
  it('counts double-bookings against the zone they occurred in', () => {
    const built = report.buildBottleneckReport({
      zones: ZONES,
      groups: GROUPS,
      assignments: [],
      statusUpdates: [],
      conflicts: [
        { type: 'zone_double_booking', zoneId: 'z1', assignmentIds: ['a1', 'a2'] },
        { type: 'zone_double_booking', zoneId: 'z1', assignmentIds: ['a3', 'a4'] },
        { type: 'zone_double_booking', zoneId: 'z2', assignmentIds: ['a5', 'a6'] },
      ],
      eventWindow: WINDOW,
    })

    expect(built.zones.find((zone) => zone.zoneId === 'z1').overlapCount).toBe(2)
    expect(built.zones.find((zone) => zone.zoneId === 'z2').overlapCount).toBe(1)
  })

  it('counts a tight transition against the zone being walked to', () => {
    const built = report.buildBottleneckReport({
      zones: ZONES,
      groups: GROUPS,
      assignments: [],
      statusUpdates: [],
      conflicts: [
        { type: 'tight_transition', groupId: 'g1', fromAssignmentId: 'a1', toAssignmentId: 'a2', gapSeconds: 120, walkSeconds: 300, source: 'estimate' },
      ],
      assignmentZone: { a1: 'z1', a2: 'z2' },
      eventWindow: WINDOW,
    })

    // The bottleneck is arriving at z2 late, so it belongs to z2.
    expect(built.zones.find((zone) => zone.zoneId === 'z2').tightTransitionCount).toBe(1)
  })
})

describe('ranking and totals', () => {
  it('ranks the busiest zones first so the report leads with the problem', () => {
    const built = report.buildBottleneckReport({
      zones: ZONES,
      groups: GROUPS,
      assignments: [
        assign('a1', 'g1', 'z1', T('09:00'), T('09:10')),
        assign('a2', 'g2', 'z2', T('09:00'), T('09:10')),
      ],
      statusUpdates: [
        status('g1', 'arrived', T('09:00')),
        status('g1', 'moving', T('09:10')),
        status('g2', 'arrived', T('09:00')),
        status('g2', 'moving', T('09:40')),
      ],
      eventWindow: WINDOW,
    })

    expect(built.zones[0].zoneId).toBe('z2')
    expect(built.zones[0].zoneName).toBe('Holding Area')
  })

  it('totals planned and actual dwell across zones', () => {
    const built = report.buildBottleneckReport({
      zones: ZONES,
      groups: GROUPS,
      assignments: [assign('a1', 'g1', 'z1', T('09:00'), T('09:30'))],
      statusUpdates: [status('g1', 'arrived', T('09:00')), status('g1', 'moving', T('09:30'))],
      eventWindow: WINDOW,
    })

    expect(built.totals.plannedDwellSeconds).toBe(30 * 60)
    expect(built.totals.actualDwellSeconds).toBe(30 * 60)
  })

  it('survives an event with no zones at all', () => {
    const built = report.buildBottleneckReport({ zones: [], groups: [], assignments: [], statusUpdates: [], eventWindow: WINDOW })

    expect(built.zones).toEqual([])
    expect(built.totals.plannedDwellSeconds).toBe(0)
  })
})
