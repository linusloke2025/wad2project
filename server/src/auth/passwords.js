/**
 * Password hashing.
 *
 * Wrapped so the rest of the app never imports the hashing library directly: the cost factor
 * lives in exactly one place, and the failure behaviour below is a testable contract.
 *
 * `bcryptjs` is used rather than native `bcrypt` because it is pure JavaScript — no native
 * compilation step on install, which keeps `npm install` reliable for every teammate and on
 * the deployment host.
 */

import bcrypt from 'bcryptjs'

// 10 rounds is the conventional floor for interactive logins: enough work to make offline
// cracking expensive without making login feel slow.
const SALT_ROUNDS = 10

/** @returns {Promise<string>} a salted bcrypt hash */
export function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, SALT_ROUNDS)
}

/**
 * Never throws: a corrupt or missing stored hash must fail the login with a plain `false`,
 * not crash the request with a 500.
 *
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plainPassword, storedHash) {
  if (typeof plainPassword !== 'string' || plainPassword === '') return false
  if (typeof storedHash !== 'string' || storedHash === '') return false

  try {
    return await bcrypt.compare(plainPassword, storedHash)
  } catch {
    return false
  }
}
