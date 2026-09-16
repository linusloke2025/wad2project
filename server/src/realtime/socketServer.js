/**
 * Socket.IO layer for live tracking.
 *
 * Everything that decides authority is re-checked here rather than trusted from the client. The
 * handshake verifies the token, joining an event re-checks that the event is in the caller's
 * community, and *every* update re-checks whether the caller may report for that specific group.
 *
 * That last check is the one that matters most. A live board where any participant can move any
 * group's marker is worse than no live board, because planners would trust it — so reporting
 * authority is derived from the stored group (is this caller its lead?) rather than from anything
 * the client sends.
 *
 * This module holds no state of its own: updates go into `liveState`, and the HTTP snapshot
 * endpoint reads the same store, so a reconnecting client resyncs against one source of truth.
 */

import { Server } from 'socket.io'

import { can } from '../domain/permissions.js'

export const EVENT_ROOM_PREFIX = 'event:'

export function createRealtimeServer({ httpServer, tokenService, repositories, liveState, broadcaster } = {}) {
  if (!httpServer) throw new Error('createRealtimeServer requires an httpServer')
  if (!tokenService) throw new Error('createRealtimeServer requires a tokenService')
  if (!repositories) throw new Error('createRealtimeServer requires repositories')
  if (!liveState) throw new Error('createRealtimeServer requires a liveState')

  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
  })

  // Announcements are authored over HTTP but delivered over the socket, so the HTTP route
  // publishes and this layer fans it out to the event's room.
  if (broadcaster) {
    broadcaster.subscribe((event, eventId, payload) => {
      io.to(EVENT_ROOM_PREFIX + eventId).emit(event, payload)
    })
  }

  // Handshake: a socket is anonymous until its token verifies.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    if (typeof token !== 'string' || token === '') {
      return next(new Error('Authentication required'))
    }
    try {
      socket.data.auth = tokenService.verify(token)
    } catch {
      return next(new Error('Authentication required'))
    }
    return next()
  })

  async function loadEvent(eventId, auth) {
    if (typeof eventId !== 'string') return null
    const event = await repositories.events.findById(eventId)
    // Cross-community access is reported as "not found" so a socket cannot probe for the
    // existence of another community's events.
    if (!event || event.communityId !== auth.communityId) return null
    return event
  }

  /** @returns {object|null} the group, but only if this caller may report for it */
  async function groupReportableBy(eventId, groupId, auth) {
    const group = await repositories.groups.findById(groupId)
    if (!group || group.eventId !== eventId) return null

    // Derived from stored state, never from the payload: a client cannot claim to be a lead.
    const isGroupLead = group.leadUserId !== null && group.leadUserId === auth.userId

    return can(auth, 'status.report', { isGroupLead }) ? group : null
  }

  io.on('connection', (socket) => {
    const { auth } = socket.data

    socket.on('event:join', async (payload = {}, ack = () => {}) => {
      try {
        const event = await loadEvent(payload.eventId, auth)
        if (!event) return ack({ ok: false, error: 'Event not found' })
        if (!can(auth, 'live.view')) return ack({ ok: false, error: 'Forbidden' })

        await socket.join(EVENT_ROOM_PREFIX + event.id)
        socket.data.eventId = event.id

        // Deliberately does NOT return the board. The room membership is all the socket needs to
        // establish, and the authoritative, community-scoped board comes from
        // `GET /api/events/:id/live`. Returning the raw live state here duplicated the merge and
        // scoping rules, and because that raw snapshot is empty until someone reports, it
        // clobbered the correct HTTP board whenever the socket connected after it.
        return ack({ ok: true })
      } catch (error) {
        return ack({ ok: false, error: error.message })
      }
    })

    socket.on('status:update', async (payload = {}, ack = () => {}) => {
      try {
        const { eventId, groupId, status } = payload

        const event = await loadEvent(eventId, auth)
        if (!event) return ack({ ok: false, error: 'Event not found' })

        const group = await groupReportableBy(eventId, groupId, auth)
        if (!group) return ack({ ok: false, error: 'Not permitted to report for this group' })

        // May throw on an unknown status; the catch below turns that into a rejection ack.
        const entry = liveState.setStatus({ eventId, groupId, status })

        // Persist as well as broadcast. Live state is what the board reads now and is lost on
        // restart; this is what the post-event report reads afterwards. Awaited so a lead is not
        // told the report was recorded when it was not.
        await repositories.statusUpdates?.create({
          eventId,
          groupId,
          status: entry.status,
          at: entry.updatedAt,
        })

        io.to(EVENT_ROOM_PREFIX + eventId).emit('status:changed', {
          groupId,
          status: entry.status,
          updatedAt: entry.updatedAt,
        })

        return ack({ ok: true })
      } catch (error) {
        return ack({ ok: false, error: error.message })
      }
    })

    socket.on('position:update', async (payload = {}, ack = () => {}) => {
      try {
        const { eventId, groupId, latitude, longitude } = payload

        const event = await loadEvent(eventId, auth)
        if (!event) return ack({ ok: false, error: 'Event not found' })

        const group = await groupReportableBy(eventId, groupId, auth)
        if (!group) return ack({ ok: false, error: 'Not permitted to report for this group' })

        const entry = liveState.setPosition({ eventId, groupId, latitude, longitude })

        io.to(EVENT_ROOM_PREFIX + eventId).emit('position:changed', {
          groupId,
          position: entry.position,
          updatedAt: entry.updatedAt,
        })

        return ack({ ok: true })
      } catch (error) {
        return ack({ ok: false, error: error.message })
      }
    })
  })

  return io
}
