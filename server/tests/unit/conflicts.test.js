import { describe, it, expect } from 'vitest'

import { detectZoneDoubleBooking } from '../../src/domain/conflicts.js'

// Acceptance criterion 4: the conflict engine flags a zone double-booking when two groups
// hold the same zone with overlapping time windows.
//
// Time windows are half-open [start, end): a slot ending exactly when the next begins is
// adjacent, not overlapping, so it must NOT be flagged.

describe('detectZoneDoubleBooking', () => {
  it('flags two different groups holding the same zone at overlapping times', () => {
    const assignments = [
      { id: 'a1', groupId: 'g1', zoneId: 'z1', start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T10:00:00+08:00' },
      { id: 'a2', groupId: 'g2', zoneId: 'z1', start: '2026-03-01T09:30:00+08:00', end: '2026-03-01T10:30:00+08:00' },
    ]

    const conflicts = detectZoneDoubleBooking(assignments)

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].type).toBe('zone_double_booking')
    expect(conflicts[0].zoneId).toBe('z1')
    expect([...conflicts[0].assignmentIds].sort()).toEqual(['a1', 'a2'])
  })

  it('does not flag adjacent slots that merely touch', () => {
    const assignments = [
      { id: 'a1', groupId: 'g1', zoneId: 'z1', start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T10:00:00+08:00' },
      { id: 'a2', groupId: 'g2', zoneId: 'z1', start: '2026-03-01T10:00:00+08:00', end: '2026-03-01T10:30:00+08:00' },
    ]

    expect(detectZoneDoubleBooking(assignments)).toEqual([])
  })

  it('does not flag the same group overlapping itself in one zone', () => {
    const assignments = [
      { id: 'a1', groupId: 'g1', zoneId: 'z1', start: '2026-03-01T09:00:00+08:00', end: '2026-03-01T10:00:00+08:00' },
      { id: 'a2', groupId: 'g1', zoneId: 'z1', start: '2026-03-01T09:30:00+08:00', end: '2026-03-01T10:30:00+08:00' },
    ]

    expect(detectZoneDoubleBooking(assignments)).toEqual([])
  })
})
