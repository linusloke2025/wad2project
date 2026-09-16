/**
 * Document serialisation: the seam between Mongoose documents and the plain objects the rest of
 * the app expects.
 *
 * Two mismatches have to be reconciled here, and both fail quietly if ignored:
 *
 *   1. Mongo calls it `_id`; every layer above calls it `id`.
 *   2. Mongoose stores dates as `Date` objects, while the conflict engine is written against ISO
 *      strings. `Date.parse` accepts a Date through string coercion, so passing one through
 *      *appears* to work while the engine's sorting and gap arithmetic silently depend on an
 *      implicit conversion. Normalising here keeps that dependency explicit.
 *
 * Kept pure so it is testable with no database, and so the Mongoose-backed repositories below it
 * stay thin enough to be obviously correct.
 */

/** Mongoose ObjectIds expose toHexString; duck-typing avoids importing mongoose here. */
function isObjectIdLike(value) {
  return value !== null && typeof value === 'object' && typeof value.toHexString === 'function'
}

function convert(node) {
  if (node === null || node === undefined) return node
  if (node instanceof Date) return node.toISOString()
  if (isObjectIdLike(node)) return String(node)
  if (Array.isArray(node)) return node.map(convert)
  if (typeof node !== 'object') return node

  const output = {}
  for (const [key, value] of Object.entries(node)) {
    // Storage detail, not data.
    if (key === '__v') continue
    if (key === '_id') {
      output.id = convert(value)
      continue
    }
    output[key] = convert(value)
  }
  return output
}

/**
 * @param {object|null|undefined} value a Mongoose document or plain object
 * @returns {object|null} a plain object with `id`, ISO dates, no `__v`
 */
export function toDto(value) {
  if (value === null || value === undefined) return null

  // Accept real documents as well as plain objects, so callers can pass either.
  const source = typeof value.toObject === 'function' ? value.toObject() : value
  return convert(source)
}

/** @returns {Array<object>} never null, so callers need no guard before iterating */
export function toDtoList(values) {
  if (!Array.isArray(values)) return []
  return values.map((value) => toDto(value))
}
