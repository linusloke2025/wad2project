import { describe, it, expect } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as liveState from '../../src/realtime/liveState.js'

// Live tracking state.
//
// Holds where each group currently is and what it is doing, per event. Kept separate from the
// transport on purpose: the socket layer decides who may report and who may listen, while this
// module only records what it is told. That split is what makes the tracking rules testable
// without opening a socket.
//
// Status and position are deliberately independent. A group lead indoors has no GPS fix but can
// still tap "arrived"; an outdoor lead has coordinates but may never tap anything. Storing them
// together would let one update wipe the other.

const T = (hhmmss) => `2026-03-01T${hhmmss}+08:00`

describe('liveState — statuses', () => {
  it('returns an empty snapshot for an event with nothing recorded', () => {
    const state = liveState.createLiveState()

    expect(state.snapshot('e1')).toEqual([])
  })

  it('records a status for a group', () => {
    const state = liveState.createLiveState()

    state.setStatus({ eventId: 'e1', groupId: 'g1', status: 'moving', at: T('09:00:00') })

    const [entry] = state.snapshot('e1')
    expect(entry).toMatchObject({ groupId: 'g1', status: 'moving' })
  })

  it('overwrites the previous status for the same group', () => {
    const state = liveState.createLiveState()

    state.setStatus({ eventId: 'e1', groupId: 'g1', status: 'moving', at: T('09:00:00') })
    state.setStatus({ eventId: 'e1', groupId: 'g1', status: 'arrived', at: T('09:05:00') })

    const snapshot = state.snapshot('e1')
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].status).toBe('arrived')
  })

  it('accepts exactly the statuses the spec defines', () => {
    const state = liveState.createLiveState()

    for (const status of liveState.STATUSES) {
      state.setStatus({ eventId: 'e1', groupId: 'g1', status, at: T('09:00:00') })
      expect(state.snapshot('e1')[0].status).toBe(status)
    }
  })

  it('rejects a status outside the set, rather than broadcasting a typo to every planner', () => {
    const state = liveState.createLiveState()

    expect(() =>
      state.setStatus({ eventId: 'e1', groupId: 'g1', status: 'teleporting', at: T('09:00:00') }),
    ).toThrow(/teleporting/)
  })
})

describe('liveState — position and status stay independent', () => {
  it('records a position without disturbing the status', () => {
    const state = liveState.createLiveState()
    state.setStatus({ eventId: 'e1', groupId: 'g1', status: 'moving', at: T('09:00:00') })

    state.setPosition({ eventId: 'e1', groupId: 'g1', latitude: 1.31955, longitude: 103.84223, at: T('09:00:10') })

    const [entry] = state.snapshot('e1')
    expect(entry.status).toBe('moving')
    expect(entry.position).toEqual({ latitude: 1.31955, longitude: 103.84223 })
  })

  it('records a status without disturbing the position', () => {
    // The indoor case: a lead has a stale fix but taps "arrived".
    const state = liveState.createLiveState()
    state.setPosition({ eventId: 'e1', groupId: 'g1', latitude: 1.3, longitude: 103.8, at: T('09:00:00') })

    state.setStatus({ eventId: 'e1', groupId: 'g1', status: 'arrived', at: T('09:00:10') })

    const [entry] = state.snapshot('e1')
    expect(entry.position).toEqual({ latitude: 1.3, longitude: 103.8 })
    expect(entry.status).toBe('arrived')
  })

  it('rejects a position that is not a usable coordinate', () => {
    const state = liveState.createLiveState()

    expect(() =>
      state.setPosition({ eventId: 'e1', groupId: 'g1', latitude: 'north', longitude: 103.8, at: T('09:00:00') }),
    ).toThrow()
  })
})

describe('liveState — isolation and housekeeping', () => {
  it('keeps events separate', () => {
    const state = liveState.createLiveState()

    state.setStatus({ eventId: 'e1', groupId: 'g1', status: 'moving', at: T('09:00:00') })
    state.setStatus({ eventId: 'e2', groupId: 'g1', status: 'delayed', at: T('09:00:00') })

    expect(state.snapshot('e1')[0].status).toBe('moving')
    expect(state.snapshot('e2')[0].status).toBe('delayed')
  })

  it('reports every group in the event', () => {
    const state = liveState.createLiveState()

    state.setStatus({ eventId: 'e1', groupId: 'g1', status: 'moving', at: T('09:00:00') })
    state.setStatus({ eventId: 'e1', groupId: 'g2', status: 'pending', at: T('09:00:00') })

    expect(state.snapshot('e1').map((entry) => entry.groupId).sort()).toEqual(['g1', 'g2'])
  })

  it('records when each entry was last updated, so the UI can show staleness', () => {
    const state = liveState.createLiveState()

    state.setStatus({ eventId: 'e1', groupId: 'g1', status: 'moving', at: T('09:00:00') })

    expect(state.snapshot('e1')[0].updatedAt).toBe(T('09:00:00'))
  })

  it('can clear an event, so an ended event stops being served from memory', () => {
    const state = liveState.createLiveState()
    state.setStatus({ eventId: 'e1', groupId: 'g1', status: 'moving', at: T('09:00:00') })

    state.clearEvent('e1')

    expect(state.snapshot('e1')).toEqual([])
  })
})
