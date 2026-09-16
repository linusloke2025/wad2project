/**
 * Event-scoped routes: the event itself plus the zones, groups, assignments and conflict check
 * that make up the plan-first walking skeleton.
 *
 * Every route resolves the event through `loadEvent`, which enforces two things at once:
 * the event must exist, and it must belong to the community in the caller's verified token.
 * A cross-community event returns 404 rather than 403 — confirming that another tenant's event
 * exists would itself be a leak.
 */

import { Router } from 'express'

import { ACK_STATUSES, summarizeAcknowledgements } from '../../domain/announcements.js'
import { requireCapability } from '../middleware/requireCapability.js'

const MIN_POLYGON_POINTS = 3

function isValidPolygon(polygon) {
  return (
    Array.isArray(polygon) &&
    polygon.length >= MIN_POLYGON_POINTS &&
    polygon.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1]),
    )
  )
}

export function createEventsRouter({ repositories, conflictService, staticMapService, liveState, broadcaster }) {
  const router = Router()

  async function loadEvent(req, res) {
    const event = await repositories.events.findById(req.params.eventId)
    if (!event || event.communityId !== req.auth.communityId) {
      res.status(404).json({ error: 'Event not found' })
      return null
    }
    return event
  }

  // The landing list. Only community scoping applies: every member of the community needs to
  // find their own event, including ordinary group members.
  router.get('/', async (req, res, next) => {
    try {
      const events = await repositories.events.listByCommunity(req.auth.communityId)
      return res.json({ events })
    } catch (error) {
      return next(error)
    }
  })

  router.post('/', requireCapability('event.create'), async (req, res, next) => {
    try {
      const { name, start, end, layoutMode, metresPerPixel, latitude, longitude, zoom } = req.body ?? {}

      if (typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'Event name is required' })
      }

      const event = await repositories.events.create({
        // Community comes from the verified token, never from the request body: trusting a
        // client-supplied communityId would let any admin write into another community.
        communityId: req.auth.communityId,
        name: name.trim(),
        start: start ?? null,
        end: end ?? null,
        layoutMode: layoutMode === 'map' ? 'map' : 'plan',
        metresPerPixel,
        // Map layouts need a centre to render a static map; without one the map degrades to a
        // placeholder rather than failing, so these stay optional.
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        zoom: Number.isFinite(zoom) ? zoom : null,
        createdBy: req.auth.userId,
      })

      return res.status(201).json(event)
    } catch (error) {
      return next(error)
    }
  })

  router.post('/:eventId/zones', requireCapability('layout.manage'), async (req, res, next) => {
    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined

      const { name, kind, polygon } = req.body ?? {}

      if (typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'Zone name is required' })
      }
      if (!isValidPolygon(polygon)) {
        return res
          .status(400)
          .json({ error: `Zone polygon must have at least ${MIN_POLYGON_POINTS} [x, y] points` })
      }

      const zone = await repositories.zones.create({
        eventId: event.id,
        name: name.trim(),
        kind: kind ?? 'zone',
        polygon,
      })

      return res.status(201).json(zone)
    } catch (error) {
      return next(error)
    }
  })

  router.post('/:eventId/groups', requireCapability('group.manage'), async (req, res, next) => {
    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined

      const { name, leadUserId } = req.body ?? {}

      if (typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'Group name is required' })
      }

      const group = await repositories.groups.create({
        eventId: event.id,
        name: name.trim(),
        leadUserId: leadUserId ?? null,
      })

      return res.status(201).json(group)
    } catch (error) {
      return next(error)
    }
  })

  router.post('/:eventId/assignments', requireCapability('group.manage'), async (req, res, next) => {
    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined

      const { groupId, zoneId, start, end } = req.body ?? {}

      if (!groupId || !zoneId || !start || !end) {
        return res
          .status(400)
          .json({ error: 'groupId, zoneId, start and end are required' })
      }

      const startMs = Date.parse(start)
      const endMs = Date.parse(end)
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
        return res.status(400).json({ error: 'start and end must be valid dates' })
      }
      if (endMs <= startMs) {
        return res.status(400).json({ error: 'An assignment must end after it starts' })
      }

      const assignment = await repositories.assignments.create({
        eventId: event.id,
        groupId,
        zoneId,
        start,
        end,
      })

      return res.status(201).json(assignment)
    } catch (error) {
      return next(error)
    }
  })

  router.get('/:eventId/layout', requireCapability('layout.view'), async (req, res, next) => {
    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined

      const zones = await repositories.zones.listByEvent(event.id)
      const map = await staticMapService.forEvent({ event, zones })

      return res.json({
        eventId: event.id,
        layoutMode: event.layoutMode,
        // Map layouts get an OneMap static map; Plan layouts get null and keep their upload.
        imageUrl: map.imageUrl,
        warning: map.warning,
        omittedShapes: map.omittedShapes,
        zones,
      })
    } catch (error) {
      return next(error)
    }
  })

  router.get('/:eventId/live', requireCapability('live.view'), async (req, res, next) => {
    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined

      const snapshot = liveState.snapshot(event.id)

      // Planning roles see the whole board. An ordinary user holds live.view too, but scoped to
      // the groups they lead — they need their own position, not everyone else's.
      if (req.auth.role !== 'user') {
        return res.json({ eventId: event.id, groups: snapshot })
      }

      const groups = await repositories.groups.listByEvent(event.id)
      const ledGroupIds = new Set(
        groups.filter((group) => group.leadUserId === req.auth.userId).map((group) => group.id),
      )

      return res.json({
        eventId: event.id,
        groups: snapshot.filter((entry) => ledGroupIds.has(entry.groupId)),
      })
    } catch (error) {
      return next(error)
    }
  })

  router.post('/:eventId/announcements', requireCapability('announcement.create'), async (req, res, next) => {
    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined

      const { body } = req.body ?? {}
      if (typeof body !== 'string' || body.trim() === '') {
        return res.status(400).json({ error: 'Announcement text is required' })
      }

      const announcement = await repositories.announcements.create({
        eventId: event.id,
        body: body.trim(),
        createdBy: req.auth.userId,
      })

      // Publish rather than emit: the socket layer subscribes if this process has one, and a
      // process without realtime can still author announcements.
      broadcaster?.publish('announcement:created', event.id, announcement)

      return res.status(201).json(announcement)
    } catch (error) {
      return next(error)
    }
  })

  router.get('/:eventId/announcements', requireCapability('live.view'), async (req, res, next) => {
    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined

      const [announcements, groups] = await Promise.all([
        repositories.announcements.listByEvent(event.id),
        repositories.groups.listByEvent(event.id),
      ])

      // Each announcement carries its own tally, so the board can show "2 of 3 acknowledged"
      // and name the groups that have not answered, without a second round trip per row.
      const withTallies = []
      for (const announcement of announcements) {
        const acknowledgements = await repositories.announcementAcks.listByAnnouncement(announcement.id)
        withTallies.push({
          ...announcement,
          acknowledgements: summarizeAcknowledgements({ groups, acknowledgements }),
        })
      }

      return res.json({ eventId: event.id, announcements: withTallies })
    } catch (error) {
      return next(error)
    }
  })

  router.post(
    '/:eventId/announcements/:announcementId/ack',
    // Reporting authority is resolved from the stored group, never from the payload, so a member
    // cannot answer on another group's behalf and corrupt the tally.
    requireCapability('status.report', {
      resolveContext: async (req) => {
        const group = await repositories.groups.findById(req.body?.groupId)
        return {
          isGroupLead: Boolean(group && group.leadUserId !== null && group.leadUserId === req.auth.userId),
        }
      },
    }),
    async (req, res, next) => {
      try {
        const event = await loadEvent(req, res)
        if (!event) return undefined

        const { groupId, status } = req.body ?? {}

        // Only these three signals are accepted. Anything else — including a free-text reply
        // someone might try to smuggle in — is refused, because that would be chat.
        if (!ACK_STATUSES.includes(status)) {
          return res.status(400).json({ error: `status must be one of: ${ACK_STATUSES.join(', ')}` })
        }

        const announcement = await repositories.announcements.findById(req.params.announcementId)
        if (!announcement || announcement.eventId !== event.id) {
          return res.status(404).json({ error: 'Announcement not found' })
        }

        const group = await repositories.groups.findById(groupId)
        if (!group || group.eventId !== event.id) {
          return res.status(404).json({ error: 'Group not found' })
        }

        await repositories.announcementAcks.upsert({
          announcementId: announcement.id,
          groupId,
          status,
          at: new Date().toISOString(),
        })

        return res.status(204).end()
      } catch (error) {
        return next(error)
      }
    },
  )

  router.get('/:eventId/conflicts', requireCapability('conflict.view'), async (req, res, next) => {    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined

      const [zones, groups, assignments] = await Promise.all([
        repositories.zones.listByEvent(event.id),
        repositories.groups.listByEvent(event.id),
        repositories.assignments.listByEvent(event.id),
      ])

      const evaluation = await conflictService.evaluate({ event, zones, groups, assignments })

      return res.json(evaluation)
    } catch (error) {
      return next(error)
    }
  })

  // Single event. Placed last so the more specific sub-resources above are matched first; the
  // path shapes differ by segment count anyway, so ordering is belt-and-braces.
  router.get('/:eventId', async (req, res, next) => {
    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined
      return res.json(event)
    } catch (error) {
      return next(error)
    }
  })

  return router
}
