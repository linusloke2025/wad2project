/**
 * Forces a first-login password change.
 *
 * Accounts are provisioned by an admin with a temporary password (docs/SPEC.md section 5.1),
 * so the session issued at that first login must not be able to do anything else until the
 * password is replaced.
 *
 * The response carries a machine-readable `code` so the Vue client can route to the
 * change-password screen instead of showing a bare "forbidden" the user cannot act on.
 */

export function requirePasswordChanged(req, res, next) {
  if (req.auth?.mustChangePassword) {
    return res.status(403).json({
      error: 'Password change required before continuing',
      code: 'PASSWORD_CHANGE_REQUIRED',
    })
  }

  return next()
}
