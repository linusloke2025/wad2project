import { describe, it, expect } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as conflicts from '../../src/domain/conflicts.js'

// The aggregate entry point the server will call when a planner loads or edits a plan.
//
// The four rules are individually tested elsewhere; this file tests only the composition:
// that every applicable rule runs, that results stay tagged by rule type, and that a clean
// plan produces nothing.

const T = (hhmm) => `2026-03-01T${hhmm}:00+08:00`

const ZONES = {
  z1: { id: 'z1', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
  z2: { id: 'z2', polygon: [[20, 0], [30, 0], [30, 10], [20, 10]] },
}

// Straddles the z1 -> z2 path, so g1's transition routes through a blocked area.
const B_BETWEEN = { id: 'bBetween', polygon: [[12, 0], [18, 0], [18, 10], [12, 10]] }

const WINDOW = { start: T('09:00'), end: T('12:00') }

describe('detectConflicts', () => {
  it('aggregates all four rules into one list', async () => {
    const assignments = [
      { id: 'a1', groupId: 'g1', zoneId: 'z1', start: T('09:00'), end: T('09:10') },
      // a3 double-books z1 against a1 ...
      { id: 'a3', groupId: 'g2', zoneId: 'z1', start: T('09:05'), end: T('09:20') },
      // ... and a2 is both a tight transition and a transit through the blocked area.
      { id: 'a2', groupId: 'g1', zoneId: 'z2', start: T('09:15'), end: T('09:30') },
    ]
    const groups = [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }]

    const found = await conflicts.detectConflicts(assignments, {
      getWalkTime: async () => ({ seconds: 900, source: 'onemap' }),
      zones: ZONES,
      blockedAreas: [B_BETWEEN],
      groups,
      eventWindow: WINDOW,
    })

    const types = found.map((c) => c.type).sort()
    expect(types).toEqual([
      'blocked_area',
      'tight_transition',
      'unscheduled_group',
      'zone_double_booking',
    ])
    expect(found).toHaveLength(4)
  })

  it('returns an empty list for a clean plan', async () => {
    const assignments = [
      { id: 'a1', groupId: 'g1', zoneId: 'z1', start: T('09:00'), end: T('09:10') },
      { id: 'a2', groupId: 'g2', zoneId: 'z2', start: T('09:00'), end: T('09:30') },
    ]
    const groups = [{ id: 'g1' }, { id: 'g2' }]

    const found = await conflicts.detectConflicts(assignments, {
      getWalkTime: async () => ({ seconds: 60, source: 'onemap' }),
      zones: ZONES,
      blockedAreas: [],
      groups,
      eventWindow: WINDOW,
    })

    expect(found).toEqual([])
  })

  it('throws when a required provider is missing rather than silently skipping a rule', async () => {
    // Silently omitting a rule would under-report conflicts, which is worse than failing loudly.
    await expect(conflicts.detectConflicts([], { eventWindow: WINDOW })).rejects.toThrow(TypeError)
    await expect(
      conflicts.detectConflicts([], { getWalkTime: async () => ({ seconds: 0, source: 'onemap' }) }),
    ).rejects.toThrow(TypeError)
  })
})
