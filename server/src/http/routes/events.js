/**
 * Event routes.
 *
 * Only the create path exists so far — enough to make the plan-first walking skeleton
 * exercisable over HTTP and to prove capability enforcement end to end.
 */

import { Router } from 'express'

import { requireCapability } from '../middleware/requireCapability.js'

export function createEventsRouter({ repositories }) {
  const router = Router()

  router.post('/', requireCapability('event.create'), async (req, res, next) => {
    try {
      const { name } = req.body ?? {}

      if (typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'Event name is required' })
      }

      const event = await repositories.events.create({
        // Community comes from the verified token, never from the request body: trusting a
        // client-supplied communityId would let any admin write into another community.
        communityId: req.auth.communityId,
        name: name.trim(),
        createdBy: req.auth.userId,
      })

      return res.status(201).json(event)
    } catch (error) {
      return next(error)
    }
  })

  return router
}
