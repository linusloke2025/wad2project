/**
 * Authentication routes: log in, read the current session, change password.
 *
 * Accounts are admin-created (docs/SPEC.md section 5.1) — there is deliberately no public
 * sign-up route here. Community mass-add via CSV is a separate, capability-guarded endpoint.
 */

import { Router } from 'express'

import { hashPassword, verifyPassword } from '../../auth/passwords.js'
import { requireAuth } from '../middleware/requireAuth.js'

// Minimum length for a replacement password. Deliberately a length floor rather than a
// composition rule: length is what actually resists offline cracking.
const MIN_PASSWORD_LENGTH = 8

export function createAuthRouter({ tokenService, repositories }) {
  const router = Router()
  const auth = requireAuth({ tokenService })

  router.post('/login', async (req, res, next) => {
    try {
      const { email, password, communityId } = req.body ?? {}

      if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        return res.status(400).json({ error: 'Email and password are required' })
      }

      const user = await repositories.users.findByEmail(email)
      const passwordMatches = user ? await verifyPassword(password, user.passwordHash) : false

      if (!user || !passwordMatches) {
        // Identical response for an unknown account and a wrong password: anything else lets
        // an attacker enumerate which emails exist.
        return res.status(401).json({ error: 'Invalid credentials' })
      }

      const memberships = await repositories.memberships.listByUser(user.id)
      if (memberships.length === 0) {
        return res.status(403).json({ error: 'No community membership' })
      }

      let membership
      if (communityId) {
        membership = memberships.find((entry) => entry.communityId === communityId)
        if (!membership) {
          return res.status(403).json({ error: 'Not a member of that community' })
        }
      } else if (memberships.length === 1) {
        membership = memberships[0]
      } else {
        // Belongs to several communities and did not say which — the client must choose, since
        // the role (and therefore every permission) differs per community.
        return res.status(400).json({
          error: 'communityId is required because this account belongs to several communities',
          communities: memberships.map((entry) => entry.communityId),
        })
      }

      const mustChangePassword = user.mustChangePassword === true

      return res.json({
        token: tokenService.sign({
          userId: user.id,
          role: membership.role,
          communityId: membership.communityId,
          mustChangePassword,
        }),
        role: membership.role,
        communityId: membership.communityId,
        mustChangePassword,
      })
    } catch (error) {
      return next(error)
    }
  })

  router.post('/password', auth, async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body ?? {}

      const user = await repositories.users.findById(req.auth.userId)
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' })
      }

      const currentMatches = await verifyPassword(currentPassword, user.passwordHash)
      if (!currentMatches) {
        return res.status(401).json({ error: 'Current password is incorrect' })
      }

      if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({
          error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        })
      }

      await repositories.users.updatePassword(user.id, {
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
      })

      // The old token still carries the flag, but it is short-lived and the client
      // immediately re-authenticates; the stored state is what matters.
      return res.status(204).end()
    } catch (error) {
      return next(error)
    }
  })

  return router
}
