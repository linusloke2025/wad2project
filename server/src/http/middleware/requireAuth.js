/**
 * Authentication guard.
 *
 * Reads `Authorization: Bearer <token>`, verifies it, and attaches the membership claims to
 * `req.auth` for downstream guards. Every failure mode returns the same 401 with the same
 * message on purpose: distinguishing "expired" from "forged" from "missing" in the response
 * would tell an attacker which guesses were closer.
 *
 * Exposed as a factory taking the token service, so tests inject their own secret and expiry.
 */

export function requireAuth({ tokenService } = {}) {
  if (!tokenService) {
    throw new Error('requireAuth requires a tokenService')
  }

  return function requireAuthMiddleware(req, res, next) {
    const header = req.headers?.authorization

    if (typeof header !== 'string' || header === '') {
      return res.status(401).json({ error: 'Authentication required' })
    }

    const [scheme, token] = header.split(' ')
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    try {
      req.auth = tokenService.verify(token)
    } catch {
      // Expired, tampered, malformed, wrong secret — all indistinguishable to the caller.
      return res.status(401).json({ error: 'Authentication required' })
    }

    return next()
  }
}
