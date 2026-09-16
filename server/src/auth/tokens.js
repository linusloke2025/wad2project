/**
 * JWT issuing and verification.
 *
 * Tokens carry the ACTIVE membership, not just the user. Roles in this app are per-community
 * (docs/SPEC.md section 4), so a token names the user AND the community they are acting in.
 * Switching communities therefore issues a new token — which is why `communityId` belongs in
 * the token rather than being resolved per request.
 *
 * Exposed as a factory so tests configure their own secret and expiry without touching env
 * vars, and so a missing secret fails loudly at startup instead of silently signing with an
 * empty key.
 */

import jwt from 'jsonwebtoken'

const DEFAULT_EXPIRY = '12h'

/**
 * @param {{secret: string, expiresIn?: string}} config
 * @returns {{sign: (claims: {userId: string, role: string, communityId: string}) => string,
 *            verify: (token: string) => {userId: string, role: string, communityId: string}}}
 */
export function createTokenService({ secret, expiresIn = DEFAULT_EXPIRY } = {}) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('createTokenService requires a non-empty secret')
  }

  return {
    sign({ userId, role, communityId, mustChangePassword = false }) {
      return jwt.sign(
        { sub: userId, role, communityId, mustChangePassword: mustChangePassword === true },
        secret,
        { expiresIn },
      )
    },

    /**
     * Throws on tampering, malformed input, or expiry. The underlying library names its
     * errors (TokenExpiredError, JsonWebTokenError), which lets the auth middleware
     * distinguish an expired session from a forged token.
     */
    verify(token) {
      const decoded = jwt.verify(token, secret)
      return {
        userId: decoded.sub,
        role: decoded.role,
        communityId: decoded.communityId,
        // Carried in the token so the server can refuse every other route on a temporary
        // password without a database round-trip per request.
        mustChangePassword: decoded.mustChangePassword === true,
      }
    },
  }
}
