import { describe, it, expect } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as conflicts from '../../src/domain/conflicts.js'

// Acceptance criterion 4 (unscheduled group).
//
// Rule: a group is unscheduled when it holds no assignment overlapping the event window —
// either no assignments at all, or only assignments outside the window. This is the gap that
// leaves a group standing in a holding area with nobody telling it when to move.

const T = (hhmm) => `2026-03-01T${hhmm}:00+08:00`
const WINDOW = { start: T('09:00'), end: T('12:00') }

const GROUPS = [
  { id: 'g1', name: 'Group 1' },
  { id: 'g2', name: 'Group 2' },
  { id: 'g3', name: 'Group 3' },
]

const scheduled = (id, groupId, start, end) => ({
  id,
  groupId,
  zoneId: 'z1',
  start: T(start),
  end: T(end),
})

describe('detectUnscheduledGroups', () => {
  it('flags a group that has no assignments at all', () => {
    const assignments = [scheduled('a1', 'g1', '09:00', '09:30')]

    const found = conflicts.detectUnscheduledGroups(GROUPS, assignments, { eventWindow: WINDOW })

    expect(found).toHaveLength(2)
    expect(found.every((c) => c.type === 'unscheduled_group')).toBe(true)
    expect(found.map((c) => c.groupId).sort()).toEqual(['g2', 'g3'])
  })

  it('does not flag a group that holds a slot inside the window', () => {
    const assignments = [
      scheduled('a1', 'g1', '09:00', '09:30'),
      scheduled('a2', 'g2', '10:00', '10:30'),
      scheduled('a3', 'g3', '11:00', '11:30'),
    ]

    expect(conflicts.detectUnscheduledGroups(GROUPS, assignments, { eventWindow: WINDOW })).toEqual([])
  })

  it('flags a group whose only slots fall entirely outside the window', () => {
    const assignments = [
      scheduled('a1', 'g1', '09:00', '09:30'),
      scheduled('a2', 'g2', '10:00', '10:30'),
      // g3 only has an evening slot, which is outside 09:00-12:00
      scheduled('a3', 'g3', '18:00', '18:30'),
    ]

    const found = conflicts.detectUnscheduledGroups(GROUPS, assignments, { eventWindow: WINDOW })

    expect(found.map((c) => c.groupId)).toEqual(['g3'])
  })

  it('does not flag a group whose slot merely overlaps the window edge', () => {
    const assignments = [
      // Starts before the window opens and runs into it: still scheduled during the event.
      scheduled('a1', 'g1', '08:45', '09:15'),
      scheduled('a2', 'g2', '10:00', '10:30'),
      scheduled('a3', 'g3', '11:00', '11:30'),
    ]

    expect(conflicts.detectUnscheduledGroups(GROUPS, assignments, { eventWindow: WINDOW })).toEqual([])
  })
})
