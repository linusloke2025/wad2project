import { describe, it, expect } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as conflicts from '../../src/domain/conflicts.js'

// Acceptance criterion 4 (blocked-area violation).
//
// Rule: an assignment violates a blocked area when either
//   - the group's zone polygon overlaps a blocked polygon  ('occupied'), or
//   - the path between consecutive zones crosses a blocked polygon ('transit').
//
// The layout designer marks blocked areas, so this rule is what makes that role matter to the
// core logic rather than being decorative.

const T = (hhmm) => `2026-03-01T${hhmm}:00+08:00`

// Zone z1 sits over the origin square; z2 is far to the right.
const ZONES = {
  z1: { id: 'z1', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
  z2: { id: 'z2', polygon: [[20, 0], [30, 0], [30, 10], [20, 10]] },
}

// b1 overlaps z1; bFar is nowhere near any zone; bBetween straddles the z1 -> z2 path.
const B1 = { id: 'b1', polygon: [[5, 5], [15, 5], [15, 15], [5, 15]] }
const B_FAR = { id: 'bFar', polygon: [[100, 100], [110, 100], [110, 110], [100, 110]] }
const B_BETWEEN = { id: 'bBetween', polygon: [[12, 0], [18, 0], [18, 10], [12, 10]] }
const B_BELOW = { id: 'bBelow', polygon: [[12, 20], [18, 20], [18, 30], [12, 30]] }

describe('detectBlockedAreaViolations', () => {
  it('flags an assignment whose zone overlaps a blocked area', () => {
    const assignments = [{ id: 'a1', groupId: 'g1', zoneId: 'z1', start: T('09:00'), end: T('09:30') }]

    const found = conflicts.detectBlockedAreaViolations(assignments, {
      zones: ZONES,
      blockedAreas: [B1],
    })

    expect(found).toHaveLength(1)
    expect(found[0].type).toBe('blocked_area')
    expect(found[0].kind).toBe('occupied')
    expect(found[0].assignmentId).toBe('a1')
    expect(found[0].zoneId).toBe('z1')
    expect(found[0].blockedAreaId).toBe('b1')
  })

  it('does not flag an assignment in a clear zone', () => {
    const assignments = [{ id: 'a1', groupId: 'g1', zoneId: 'z1', start: T('09:00'), end: T('09:30') }]

    const found = conflicts.detectBlockedAreaViolations(assignments, {
      zones: ZONES,
      blockedAreas: [B_FAR],
    })

    expect(found).toEqual([])
  })

  it('flags a transition whose path crosses a blocked area', () => {
    const assignments = [
      { id: 'a1', groupId: 'g1', zoneId: 'z1', start: T('09:00'), end: T('09:10') },
      { id: 'a2', groupId: 'g1', zoneId: 'z2', start: T('09:30'), end: T('09:40') },
    ]

    const found = conflicts.detectBlockedAreaViolations(assignments, {
      zones: ZONES,
      blockedAreas: [B_BETWEEN],
    })

    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('transit')
    expect(found[0].fromAssignmentId).toBe('a1')
    expect(found[0].toAssignmentId).toBe('a2')
    expect(found[0].blockedAreaId).toBe('bBetween')
  })

  it('does not flag a transition that steers clear of a blocked area', () => {
    const assignments = [
      { id: 'a1', groupId: 'g1', zoneId: 'z1', start: T('09:00'), end: T('09:10') },
      { id: 'a2', groupId: 'g1', zoneId: 'z2', start: T('09:30'), end: T('09:40') },
    ]

    const found = conflicts.detectBlockedAreaViolations(assignments, {
      zones: ZONES,
      blockedAreas: [B_BELOW],
    })

    expect(found).toEqual([])
  })

  it('skips assignments whose zone is unknown instead of throwing', () => {
    const assignments = [{ id: 'a1', groupId: 'g1', zoneId: 'ghost', start: T('09:00'), end: T('09:30') }]

    expect(() =>
      conflicts.detectBlockedAreaViolations(assignments, { zones: ZONES, blockedAreas: [B1] }),
    ).not.toThrow()
    expect(
      conflicts.detectBlockedAreaViolations(assignments, { zones: ZONES, blockedAreas: [B1] }),
    ).toEqual([])
  })
})
