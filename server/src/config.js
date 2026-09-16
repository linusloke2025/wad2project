/**
 * Configuration loading and validation.
 *
 * Takes the environment as an argument rather than reading `process.env` directly, so it is a
 * pure function: no global mutation, no test-ordering hazards, and no hidden dependency on
 * whatever happened to be exported when the module was first imported.
 *
 * Validating here is about failure *timing*. A missing JWT secret should stop the process at
 * startup with a sentence naming the variable — not surface hours later as inexplicable 401s, or
 * worse, as tokens happily signed with an empty key.
 *
 * Error messages name variables but never echo their values: configuration errors get logged,
 * pasted into chats, and quoted in bug reports.
 */

const DEFAULT_PORT = 3000
const MIN_PORT = 1
const MAX_PORT = 65535

/**
 * @param {Record<string, string|undefined>} [env]
 * @throws {Error} when a required variable is missing or malformed
 */
export function loadConfig(env = process.env) {
  const missing = []

  const jwtSecret = (env.JWT_SECRET ?? '').trim()
  const mongodbUri = (env.MONGODB_URI ?? '').trim()

  if (jwtSecret === '') missing.push('JWT_SECRET')
  if (mongodbUri === '') missing.push('MONGODB_URI')

  if (missing.length > 0) {
    // Report every missing variable at once, so one restart fixes the whole set.
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. See server/.env.example.`,
    )
  }

  let port = DEFAULT_PORT
  const rawPort = env.PORT === undefined ? '' : String(env.PORT).trim()
  if (rawPort !== '') {
    port = Number(rawPort)
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
      throw new Error(`PORT must be an integer between ${MIN_PORT} and ${MAX_PORT}.`)
    }
  }

  const onemapEmail = (env.ONEMAP_EMAIL ?? '').trim() || undefined
  const onemapPassword = (env.ONEMAP_PASSWORD ?? '').trim() || undefined

  return {
    jwtSecret,
    mongodbUri,
    port,
    // Optional on purpose: the Static Map API needs no credentials at all, so the app runs
    // without these. They enable real walking times for Map-layout events via the Route Service.
    onemapEmail,
    onemapPassword,
    hasOneMapRouting: Boolean(onemapEmail && onemapPassword),
  }
}
