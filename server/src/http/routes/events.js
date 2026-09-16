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
import multer from 'multer'

import { ACK_STATUSES, summarizeAcknowledgements } from '../../domain/announcements.js'
import { buildBottleneckReport } from '../../domain/bottleneckReport.js'
import { requireCapability } from '../middleware/requireCapability.js'

const MIN_POLYGON_POINTS = 3

/**
 * Floor-plan uploads are capped because they are stored in the database, which has a fixed
 * quota shared with all other data — an unbounded upload path would let one designer exhaust it.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const uploadImage = multer({
  // In memory rather than on disk: the buffer goes straight to storage, so there is no temporary
  // file to leak or clean up if the request fails partway.
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!file.mimetype?.startsWith('image/')) {
      const error = new Error('Only image files are supported')
      error.code = 'NOT_AN_IMAGE'
      return callback(error)
    }
    return callback(null, true)
  },
}).single('image')

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

  /**
   * Assign a group's members and designate its leader.
   *
   * The invariant enforced here is that a lead must be one of the group's members. Without it a
   * lead could report on behalf of people they are not part of, and the live board would present
   * that as authoritative to planners — which is worse than refusing it.
   */
  router.patch('/:eventId/groups/:groupId', requireCapability('group.manage'), async (req, res, next) => {
    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined

      const group = await repositories.groups.findById(req.params.groupId)
      // A group from another event is "not found" rather than forbidden, so a caller cannot probe
      // for groups they have no business knowing about.
      if (!group || group.eventId !== event.id) {
        return res.status(404).json({ error: 'Group not found' })
      }

      const { memberIds, leadUserId } = req.body ?? {}

      if (memberIds !== undefined && !Array.isArray(memberIds)) {
        return res.status(400).json({ error: 'memberIds must be an array of user ids' })
      }

      const nextMemberIds = memberIds === undefined ? (group.memberIds ?? []) : memberIds
      const nextLeadUserId = leadUserId === undefined ? (group.leadUserId ?? null) : leadUserId

      // Membership is per community, so a group cannot be staffed from outside it.
      const memberships = await repositories.memberships.listByCommunity(req.auth.communityId)
      const communityUserIds = new Set(memberships.map((entry) => entry.userId))

      const outsider = nextMemberIds.find((userId) => !communityUserIds.has(userId))
      if (outsider) {
        return res.status(400).json({ error: 'Every member must belong to this community' })
      }

      if (
        nextLeadUserId !== null &&
        nextLeadUserId !== undefined &&
        !nextMemberIds.includes(nextLeadUserId)
      ) {
        return res.status(400).json({ error: 'The lead must be a member of the group' })
      }

      const updated = await repositories.groups.update(group.id, {
        memberIds: nextMemberIds,
        leadUserId: nextLeadUserId ?? null,
      })

      return res.json(updated)
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

  // Upload the floor plan a Plan layout is drawn on.
  //
  // The capability guard runs before multer so a role that may not edit the layout is refused
  // without its bytes being read or buffered at all.
  router.post(
    '/:eventId/layout/image',
    requireCapability('layout.manage'),
    (req, res, next) => {
      uploadImage(req, res, (error) => {
        if (!error) return next()

        if (error.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Image is larger than the 5MB limit' })
        }
        if (error.code === 'NOT_AN_IMAGE') {
          return res.status(400).json({ error: error.message })
        }
        return next(error)
      })
    },
    async (req, res, next) => {
      try {
        const event = await loadEvent(req, res)
        if (!event) return undefined

        if (!req.file) {
          return res.status(400).json({ error: 'An image file is required' })
        }

        const layoutImageId = await repositories.layoutImages.put({
          eventId: event.id,
          buffer: req.file.buffer,
          contentType: req.file.mimetype,
        })

        await repositories.events.updateLayoutImage(event.id, layoutImageId)

        return res.status(201).json({ imageUrl: `/api/events/${event.id}/layout/image` })
      } catch (error) {
        return next(error)
      }
    },
  )

  router.get('/:eventId/layout/image', requireCapability('layout.view'), async (req, res, next) => {
    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined

      if (!event.layoutImageId) {
        return res.status(404).json({ error: 'No layout image has been uploaded' })
      }

      const image = await repositories.layoutImages.get(event.layoutImageId)
      if (!image) {
        return res.status(404).json({ error: 'No layout image has been uploaded' })
      }

      res.set('Content-Type', image.contentType)
      // Private: the image sits behind the same authorization as the event it belongs to.
      res.set('Cache-Control', 'private, max-age=300')
      return res.send(image.buffer)
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

      // A Map layout is an OneMap static map; a Plan layout is whatever the designer uploaded,
      // so its image is served from our own endpoint rather than generated.
      const imageUrl =
        event.layoutMode === 'map'
          ? map.imageUrl
          : event.layoutImageId
            ? `/api/events/${event.id}/layout/image`
            : null

      return res.json({
        eventId: event.id,
        layoutMode: event.layoutMode,
        imageUrl,
        warning: event.layoutMode === 'map' ? map.warning : null,
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

      const eventGroups = await repositories.groups.listByEvent(event.id)
      const snapshot = liveState.snapshot(event.id)
      const liveByGroup = new Map(snapshot.map((entry) => [entry.groupId, entry]))

      // Every group appears, whether or not it has reported. A board that lists only the groups
      // that have said something hides the ones that have not — and a group nobody has heard
      // from is exactly the silence this app exists to surface.
      let board = eventGroups.map((group) => ({
        groupId: group.id,
        name: group.name,
        status: null,
        position: null,
        updatedAt: null,
        ...(liveByGroup.get(group.id) ?? {}),
        // Spread last-but-one so a stale snapshot cannot rename or re-key a group that has since
        // been deleted and recreated.
        groupId: group.id,
        name: group.name,
      }))

      // Planning roles see the whole board. An ordinary user holds live.view too, but scoped to
      // the groups they lead — they need their own position, not everyone else's.
      if (req.auth.role === 'user') {
        board = board.filter((entry) => {
          const group = eventGroups.find((candidate) => candidate.id === entry.groupId)
          return Boolean(group && group.leadUserId === req.auth.userId)
        })
      }

      return res.json({ eventId: event.id, groups: board })
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

  // Group composition and timings are planning data, so these are gated like the conflict list
  // rather than being open to everyone in the community.
  router.get('/:eventId/groups', requireCapability('conflict.view'), async (req, res, next) => {
    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined

      const groups = await repositories.groups.listByEvent(event.id)
      return res.json({ groups })
    } catch (error) {
      return next(error)
    }
  })

  router.get('/:eventId/assignments', requireCapability('conflict.view'), async (req, res, next) => {
    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined

      const assignments = await repositories.assignments.listByEvent(event.id)
      return res.json({ assignments })
    } catch (error) {
      return next(error)
    }
  })

  router.get('/:eventId/report', requireCapability('report.view'), async (req, res, next) => {
    try {
      const event = await loadEvent(req, res)
      if (!event) return undefined

      const [zones, groups, assignments] = await Promise.all([
        repositories.zones.listByEvent(event.id),
        repositories.groups.listByEvent(event.id),
        repositories.assignments.listByEvent(event.id),
      ])

      // Optional so a deployment or test double without status history still serves the plan
      // half of the report rather than erroring.
      const statusUpdates = repositories.statusUpdates
        ? await repositories.statusUpdates.listByEvent(event.id)
        : []

      const evaluation = await conflictService.evaluate({ event, zones, groups, assignments })

      // The report needs to know which zone a transition was heading to.
      const assignmentZone = Object.fromEntries(assignments.map((entry) => [entry.id, entry.zoneId]))

      const report = buildBottleneckReport({
        zones,
        groups,
        assignments,
        statusUpdates,
        conflicts: evaluation.conflicts,
        assignmentZone,
        eventWindow: { start: event.start, end: event.end },
      })

      return res.json({ eventId: event.id, report })
    } catch (error) {
      return next(error)
    }
  })

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
