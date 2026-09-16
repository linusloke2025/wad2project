import { describe, it, expect } from 'vitest'

// Namespace import on purpose: a missing *named* export would fail at ESM link time as a
// syntax error, which is not valid red evidence. Calling a property that does not exist yet
// fails for the right reason — the missing behaviour.
import * as conflicts from '../../src/domain/conflicts.js'

// Acceptance criterion 4 (tight transition) and criterion 5 (routed vs estimated labelling).
//
// Rule: for one group's itinerary in chronological order, a transition is tight when the gap
// between the end of one slot and the start of the next is shorter than the walking time
// between those two zones.
//
// The walk time comes from an injected provider so the rule is testable without OneMap:
//   getWalkTime(fromZoneId, toZoneId) -> Promise<{ seconds, source: 'onemap' | 'estimate' }>
// The `source` must survive into the conflict so a scaled straight-line estimate is never
// presented as a real routed time (Plan layout mode vs Map layout mode).

const T = (hhmm) => `2026-03-01T${hhmm}:00+08:00`

describe('detectTightTransitions', () => {
  it('flags a transition whose gap is shorter than the walking time', async () => {
    const itinerary = [
      { id: 'a1', groupId: 'g1', zoneId: 'z1', start: T('09:00'), end: T('09:10') },
      { id: 'a2', groupId: 'g1', zoneId: 'z2', start: T('09:15'), end: T('09:30') },
    ]
    const getWalkTime = async () => ({ seconds: 900, source: 'onemap' })

    const found = await conflicts.detectTightTransitions(itinerary, { getWalkTime })

    expect(found).toHaveLength(1)
    expect(found[0].type).toBe('tight_transition')
    expect(found[0].groupId).toBe('g1')
    expect(found[0].fromAssignmentId).toBe('a1')
    expect(found[0].toAssignmentId).toBe('a2')
    expect(found[0].gapSeconds).toBe(300)
    expect(found[0].walkSeconds).toBe(900)
    expect(found[0].source).toBe('onemap')
  })

  it('does not flag when the gap is at least the walking time', async () => {
    const itinerary = [
      { id: 'a1', groupId: 'g1', zoneId: 'z1', start: T('09:00'), end: T('09:10') },
      { id: 'a2', groupId: 'g1', zoneId: 'z2', start: T('09:30'), end: T('09:45') },
    ]
    const getWalkTime = async () => ({ seconds: 900, source: 'onemap' })

    expect(await conflicts.detectTightTransitions(itinerary, { getWalkTime })).toEqual([])
  })

  it('carries the estimate label through so estimates are never shown as routed times', async () => {
    const itinerary = [
      { id: 'a1', groupId: 'g1', zoneId: 'z1', start: T('09:00'), end: T('09:10') },
      { id: 'a2', groupId: 'g1', zoneId: 'z2', start: T('09:15'), end: T('09:30') },
    ]
    const getWalkTime = async () => ({ seconds: 900, source: 'estimate' })

    const found = await conflicts.detectTightTransitions(itinerary, { getWalkTime })

    expect(found).toHaveLength(1)
    expect(found[0].source).toBe('estimate')
  })

  it('only compares consecutive slots of the same group', async () => {
    const itinerary = [
      { id: 'a1', groupId: 'g1', zoneId: 'z1', start: T('09:00'), end: T('09:10') },
      { id: 'b1', groupId: 'g2', zoneId: 'z3', start: T('09:11'), end: T('09:20') },
      { id: 'a2', groupId: 'g1', zoneId: 'z2', start: T('09:30'), end: T('09:45') },
    ]
    const getWalkTime = async () => ({ seconds: 900, source: 'onemap' })

    // g1's real gap is 09:10 -> 09:30 = 1200s, which is fine; g2's interleaved slot must not
    // be spliced into g1's sequence.
    expect(await conflicts.detectTightTransitions(itinerary, { getWalkTime })).toEqual([])
  })
})
