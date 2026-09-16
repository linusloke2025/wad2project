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

export function createEventsRouter({ repositories, conflictService }) {
  const router = Router()

  async function loadEvent(req, res) {
    const event = await repositories.events.findById(req.params.eventId)
    if (!event || event.communityId !== req.auth.communityId) {
      res.status(404).json({ error: 'Event not found' })
      return null
    }
    return event
  }

  router.post('/', requireCapability('event.create'), async (req, res, next) => {
    try {
      const { name, start, end, layoutMode, metresPerPixel } = req.body ?? {}

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

  router.get('/:eventId/conflicts', requireCapability('conflict.view'), async (req, res, next) => {
    try {
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

  return router
}
