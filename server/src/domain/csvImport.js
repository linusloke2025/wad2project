/**
 * CSV roster import for community mass-add (docs/SPEC.md section 5.1).
 *
 * Pure on purpose. The spec's failure mode is explicit — an invalid row must be reported
 * per-row while the valid rows still import, with no partial corruption — so this module never
 * touches the database and never writes anything. It returns both the acceptable rows and the
 * rejections, each with its original line number, so an admin can fix the file and re-upload.
 *
 * Duplicate detection here is within the file only. Checking against accounts that already
 * exist needs the database and belongs to the caller.
 */

const REQUIRED_COLUMNS = ['name', 'email', 'tempPassword']

/** Thrown when the file itself is unusable, as opposed to a single bad row. */
export class CsvFormatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CsvFormatError'
  }
}

/**
 * Split one CSV line into fields, honouring double quotes so a name like
 * `"Loke, Alice"` survives. Escaped quotes (`""`) collapse to a single quote.
 */
function parseCsvLine(line) {
  const fields = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }

  fields.push(current)
  return fields.map((field) => field.trim())
}

/** Deliberately permissive: enough to catch typos, not a spec-complete RFC 5322 validator. */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/**
 * @param {string} csvText
 * @returns {{valid: Array<{name: string, email: string, tempPassword: string, line: number}>,
 *            errors: Array<{line: number, raw: string, message: string}>}}
 * @throws {CsvFormatError} when a required column is missing or the file is empty
 */
export function parseUserCsv(csvText) {
  if (typeof csvText !== 'string' || csvText.trim() === '') {
    throw new CsvFormatError('CSV file is empty')
  }

  const lines = csvText.split(/\r?\n/)

  const headerIndex = lines.findIndex((line) => line.trim() !== '')
  const header = parseCsvLine(lines[headerIndex]).map((column) => column.toLowerCase())

  const columnIndex = {}
  for (const column of REQUIRED_COLUMNS) {
    const index = header.indexOf(column.toLowerCase())
    if (index === -1) {
      throw new CsvFormatError(`CSV header is missing required column: ${column}`)
    }
    columnIndex[column] = index
  }

  const valid = []
  const errors = []
  const seenEmails = new Set()

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i].trim()
    if (raw === '') continue

    const line = i + 1
    const fields = parseCsvLine(lines[i])
    const field = (column) => (fields[columnIndex[column]] ?? '').trim()

    const name = field('name')
    const email = field('email')
    const tempPassword = field('tempPassword')

    if (name === '') {
      errors.push({ line, raw, message: 'Missing name' })
      continue
    }
    if (!isValidEmail(email)) {
      errors.push({ line, raw, message: `Invalid email address: ${email || '(empty)'}` })
      continue
    }
    if (tempPassword === '') {
      errors.push({ line, raw, message: 'Missing temporary password' })
      continue
    }

    const key = email.toLowerCase()
    if (seenEmails.has(key)) {
      errors.push({ line, raw, message: `Duplicate email in file: ${email}` })
      continue
    }
    seenEmails.add(key)

    valid.push({ name, email, tempPassword, line })
  }

  return { valid, errors }
}
