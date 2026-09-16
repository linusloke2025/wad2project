/**
 * Capability guard — the server-side half of acceptance criterion 3.
 *
 * This is what makes the RBAC matrix enforceable rather than cosmetic: hiding a button in Vue
 * is not access control, and the brief's app is graded on whether the server refuses what the
 * role may not do.
 *
 * `resolveContext` exists because some capabilities depend on the *target*, not just the actor
 * — an admin may manage ordinary users but not other admins. Resolving that may require a
 * database lookup (is this user the lead of this group?), so the resolver may be async.
 */

import { can } from '../../domain/permissions.js'

/**
 * @param {string} capability one of ALL_CAPABILITIES
 * @param {{resolveContext?: (req: object) => object|Promise<object>}} [options]
 */
export function requireCapability(capability, { resolveContext } = {}) {
  return async function requireCapabilityMiddleware(req, res, next) {
    if (!req.auth) {
      // The auth guard should have run first; if it did not, fail as unauthenticated rather
      // than silently treating the request as anonymous.
      return res.status(401).json({ error: 'Authentication required' })
    }

    const context = resolveContext ? await resolveContext(req) : {}

    if (!can(req.auth, capability, context)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    return next()
  }
}
