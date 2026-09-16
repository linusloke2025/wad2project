import { describe, it, expect } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as announcements from '../../src/domain/announcements.js'

// Announcement acknowledgement tallies.
//
// Announcements are one-way: a planner broadcasts, and group leads respond with a fixed signal.
// There is deliberately NO free-text field — a text box would make this chat, and the whole
// point is to replace the messy-Telegram problem without rebuilding Telegram.
//
// The tally is what makes the reactions useful. "Did every group receive the change?" is the
// exact gap Telegram leaves, so the important output is not the counts but who has NOT answered.
//
// Pure, so no database or socket is needed.

const GROUPS = [
  { id: 'g1', name: 'Group 1' },
  { id: 'g2', name: 'Group 2' },
  { id: 'g3', name: 'Group 3' },
]

const ack = (groupId, status) => ({ groupId, status, at: '2026-03-01T09:00:00+08:00' })

describe('summarizeAcknowledgements — who has not answered', () => {
  it('lists every group as awaiting a response when nobody has answered', () => {
    const tally = announcements.summarizeAcknowledgements({ groups: GROUPS, acknowledgements: [] })

    expect(tally.awaitingResponseGroupIds).toEqual(['g1', 'g2', 'g3'])
    expect(tally.acknowledgedGroupIds).toEqual([])
    expect(tally.allAcknowledged).toBe(false)
  })

  it('removes a group from awaiting once it responds at all', () => {
    const tally = announcements.summarizeAcknowledgements({
      groups: GROUPS,
      acknowledgements: [ack('g1', 'acknowledged')],
    })

    expect(tally.awaitingResponseGroupIds).toEqual(['g2', 'g3'])
  })

  it('does not treat "need help" as an acknowledgement of the instruction', () => {
    // A group that needs help has answered, but has not confirmed it can comply. The planner
    // must see that distinction rather than a false "everyone is fine".
    const tally = announcements.summarizeAcknowledgements({
      groups: GROUPS,
      acknowledgements: [ack('g1', 'acknowledged'), ack('g2', 'need_help')],
    })

    expect(tally.acknowledgedGroupIds).toEqual(['g1'])
    expect(tally.needHelpGroupIds).toEqual(['g2'])
    expect(tally.awaitingResponseGroupIds).toEqual(['g3'])
    expect(tally.notAcknowledgedGroupIds).toEqual(['g2', 'g3'])
    expect(tally.allAcknowledged).toBe(false)
  })
})

describe('summarizeAcknowledgements — counts', () => {
  it('counts each response type', () => {
    const tally = announcements.summarizeAcknowledgements({
      groups: GROUPS,
      acknowledgements: [ack('g1', 'acknowledged'), ack('g2', 'need_help'), ack('g3', 'cant_comply')],
    })

    expect(tally.counts).toEqual({ acknowledged: 1, need_help: 1, cant_comply: 1 })
  })

  it('reports totals so a UI can render "2 of 3"', () => {
    const tally = announcements.summarizeAcknowledgements({
      groups: GROUPS,
      acknowledgements: [ack('g1', 'acknowledged'), ack('g2', 'acknowledged')],
    })

    expect(tally.totalGroups).toBe(2 + 1)
    expect(tally.acknowledgedGroupIds).toHaveLength(2)
  })

  it('sets allAcknowledged only when every group has acknowledged', () => {
    const all = announcements.summarizeAcknowledgements({
      groups: GROUPS,
      acknowledgements: [ack('g1', 'acknowledged'), ack('g2', 'acknowledged'), ack('g3', 'acknowledged')],
    })
    expect(all.allAcknowledged).toBe(true)
    expect(all.notAcknowledgedGroupIds).toEqual([])

    const almost = announcements.summarizeAcknowledgements({
      groups: GROUPS,
      acknowledgements: [ack('g1', 'acknowledged'), ack('g2', 'acknowledged')],
    })
    expect(almost.allAcknowledged).toBe(false)
  })

  it('treats an event with no groups as vacuously acknowledged rather than perpetually pending', () => {
    const tally = announcements.summarizeAcknowledgements({ groups: [], acknowledgements: [] })

    expect(tally.totalGroups).toBe(0)
    expect(tally.awaitingResponseGroupIds).toEqual([])
    expect(tally.allAcknowledged).toBe(true)
  })
})

describe('summarizeAcknowledgements — robustness', () => {
  it('ignores a response from a group that is not in the event', () => {
    // A stale row from a deleted group must not inflate the counts.
    const tally = announcements.summarizeAcknowledgements({
      groups: GROUPS,
      acknowledgements: [ack('g1', 'acknowledged'), ack('deleted-group', 'acknowledged')],
    })

    expect(tally.acknowledgedGroupIds).toEqual(['g1'])
    expect(tally.counts.acknowledged).toBe(1)
  })

  it('takes the latest response when a group changes its mind', () => {
    const tally = announcements.summarizeAcknowledgements({
      groups: GROUPS,
      acknowledgements: [
        { groupId: 'g1', status: 'need_help', at: '2026-03-01T09:00:00+08:00' },
        { groupId: 'g1', status: 'acknowledged', at: '2026-03-01T09:05:00+08:00' },
      ],
    })

    expect(tally.acknowledgedGroupIds).toEqual(['g1'])
    expect(tally.needHelpGroupIds).toEqual([])
  })

  it('accepts exactly the three signals and no others', () => {
    expect(announcements.ACK_STATUSES).toEqual(['acknowledged', 'need_help', 'cant_comply'])
  })
})
