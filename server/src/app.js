/**
 * Express application factory.
 *
 * Repositories are injected rather than imported so the whole app can be exercised over real
 * HTTP without MongoDB. The Mongoose-backed implementations satisfy the same interface, and
 * the unit tests use in-memory fakes — which keeps the feedback loop at milliseconds and means
 * routing, body parsing and the middleware chain are all genuinely covered.
 */

import express from 'express'

import { requireAuth } from './http/middleware/requireAuth.js'
import { requirePasswordChanged } from './http/middleware/requirePasswordChanged.js'
import { createAuthRouter } from './http/routes/auth.js'
import { createEventsRouter } from './http/routes/events.js'
import { createConflictService } from './services/conflictService.js'
import { createStaticMapService } from './services/staticMapService.js'

export function createApp({ tokenService, repositories, conflictService, staticMapService } = {}) {
  if (!tokenService) throw new Error('createApp requires a tokenService')
  if (!repositories) throw new Error('createApp requires repositories')

  const app = express()

  app.use(express.json())

  const auth = requireAuth({ tokenService })

  // Defaults to a plan-mode service, which estimates walk times and needs no OneMap client.
  const conflicts = conflictService ?? createConflictService({ onemapClient: null })
  const staticMaps = staticMapService ?? createStaticMapService()

  // Unauthenticated by design: logging in is how you get a token.
  app.use('/api/auth', createAuthRouter({ tokenService, repositories }))

  app.get('/api/me', auth, (req, res) => {
    res.json({
      userId: req.auth.userId,
      role: req.auth.role,
      communityId: req.auth.communityId,
      mustChangePassword: req.auth.mustChangePassword,
    })
  })

  // Everything below requires a session that is not stuck on a temporary password.
  app.use(
    '/api/events',
    auth,
    requirePasswordChanged,
    createEventsRouter({ repositories, conflictService: conflicts, staticMapService: staticMaps }),
  )

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  app.use((error, req, res, next) => {
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Malformed JSON body' })
    }

    console.error(error)
    return res.status(500).json({ error: 'Internal server error' })
  })

  return app
}
