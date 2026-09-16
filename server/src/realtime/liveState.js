/**
 * Live tracking state.
 *
 * Holds where each group currently is and what it is doing, per event. Deliberately separate
 * from the transport: the socket layer decides who may report and who may listen, while this
 * module only records what it is told. That split is what lets the tracking rules be tested
 * without opening a socket.
 *
 * Status and position are independent. A lead indoors has no GPS fix but can still tap
 * "arrived"; an outdoor lead has coordinates but may never tap anything. Storing them in one
 * field would let whichever update arrived second wipe the other.
 *
 * This is process memory, not a database. The source of truth for what happened is the stored
 * PositionPing history; this is the fast current view the live board reads, and it is rebuilt
 * from stored data on reconnect if a process restarts.
 */

/** The four states a group can be in, as agreed in the spec. */
export const STATUSES = ['pending', 'moving', 'arrived', 'delayed']

export function createLiveState() {
  /** @type {Map<string, Map<string, {groupId: string, status: string|null, position: object|null, updatedAt: string|null}>>} */
  const byEvent = new Map()

  function entryFor(eventId, groupId) {
    if (!byEvent.has(eventId)) byEvent.set(eventId, new Map())
    const groups = byEvent.get(eventId)

    if (!groups.has(groupId)) {
      groups.set(groupId, { groupId, status: null, position: null, updatedAt: null })
    }
    return groups.get(groupId)
  }

  function setStatus({ eventId, groupId, status, at }) {
    if (!STATUSES.includes(status)) {
      // Rejecting here rather than broadcasting means a typo cannot reach every planner's board.
      throw new Error(`Unknown status: ${status}. Expected one of ${STATUSES.join(', ')}.`)
    }

    const entry = entryFor(eventId, groupId)
    entry.status = status
    entry.updatedAt = at ?? new Date().toISOString()
    return { ...entry }
  }

  function setPosition({ eventId, groupId, latitude, longitude, at }) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('A position requires numeric latitude and longitude.')
    }

    const entry = entryFor(eventId, groupId)
    entry.position = { latitude, longitude }
    entry.updatedAt = at ?? new Date().toISOString()
    return { ...entry }
  }

  /** @returns {Array<object>} a copy, so callers cannot mutate live state by accident */
  function snapshot(eventId) {
    const groups = byEvent.get(eventId)
    if (!groups) return []

    return [...groups.values()].map((entry) => ({
      ...entry,
      position: entry.position ? { ...entry.position } : null,
    }))
  }

  function clearEvent(eventId) {
    byEvent.delete(eventId)
  }

  return { setStatus, setPosition, snapshot, clearEvent }
}
