import { describe, it, expect } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as csvImport from '../../src/domain/csvImport.js'

// CSV mass-add for community rosters (docs/SPEC.md section 5.1).
//
// The spec's failure mode is explicit: an invalid row must be reported per-row, the valid rows
// must still import, and a bad file must not partially corrupt the roster. So this function is
// pure and all-or-nothing per row — it never touches the database, and it returns both the
// acceptable rows and the rejections with their original line numbers so the admin can fix the
// file and re-upload.
//
// Duplicate detection here is within the file only. Checking against existing accounts needs a
// database and belongs to the caller.

const HEADER = 'name,email,tempPassword\n'

describe('parseUserCsv — happy path', () => {
  it('parses a well-formed roster', () => {
    const csv = `${HEADER}Alice Tan,alice@example.com,temp1234\nBob Lee,bob@example.com,temp5678\n`

    const result = csvImport.parseUserCsv(csv)

    expect(result.errors).toEqual([])
    expect(result.valid).toHaveLength(2)
    expect(result.valid[0]).toMatchObject({
      name: 'Alice Tan',
      email: 'alice@example.com',
      tempPassword: 'temp1234',
      line: 2,
    })
    expect(result.valid[1].email).toBe('bob@example.com')
  })

  it('respects column order given by the header', () => {
    const csv = 'email,tempPassword,name\nalice@example.com,temp1234,Alice Tan\n'

    const result = csvImport.parseUserCsv(csv)

    expect(result.errors).toEqual([])
    expect(result.valid[0]).toMatchObject({
      name: 'Alice Tan',
      email: 'alice@example.com',
      tempPassword: 'temp1234',
    })
  })

  it('skips blank lines without reporting them as errors', () => {
    const csv = `${HEADER}Alice,alice@example.com,temp1234\n\nBob,bob@example.com,temp5678\n\n`

    const result = csvImport.parseUserCsv(csv)

    expect(result.errors).toEqual([])
    expect(result.valid).toHaveLength(2)
  })

  it('handles quoted fields containing commas', () => {
    const csv = `${HEADER}"Loke, Alice",alice@example.com,temp1234\n`

    const result = csvImport.parseUserCsv(csv)

    expect(result.errors).toEqual([])
    expect(result.valid[0].name).toBe('Loke, Alice')
  })
})

describe('parseUserCsv — per-row rejections', () => {
  it('rejects a row with a missing name, keeping the rest', () => {
    const csv = `${HEADER}Alice,alice@example.com,temp1234\n,broken@example.com,temp5678\n`

    const result = csvImport.parseUserCsv(csv)

    expect(result.valid).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].line).toBe(3)
    expect(result.errors[0].message).toMatch(/name/i)
  })

  it('rejects a row with an invalid email address', () => {
    const csv = `${HEADER}Alice,not-an-email,temp1234\n`

    const result = csvImport.parseUserCsv(csv)

    expect(result.valid).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/email/i)
  })

  it('rejects a row with no temporary password', () => {
    const csv = `${HEADER}Alice,alice@example.com,\n`

    const result = csvImport.parseUserCsv(csv)

    expect(result.valid).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/password/i)
  })

  it('rejects a duplicate email within the file, case-insensitively, keeping the first', () => {
    const csv = `${HEADER}Alice,alice@example.com,temp1234\nAlicia,ALICE@example.com,temp5678\n`

    const result = csvImport.parseUserCsv(csv)

    expect(result.valid).toHaveLength(1)
    expect(result.valid[0].name).toBe('Alice')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].line).toBe(3)
    expect(result.errors[0].message).toMatch(/duplicate/i)
  })

  it('reports the original line number and raw text so the admin can find the row', () => {
    const csv = `${HEADER}Alice,alice@example.com,temp1234\nBob,bob@example.com,temp5678\n,oops@example.com,temp9999\n`

    const result = csvImport.parseUserCsv(csv)

    expect(result.errors[0].line).toBe(4)
    expect(result.errors[0].raw).toBe(',oops@example.com,temp9999')
  })
})

describe('parseUserCsv — malformed file', () => {
  it('throws when a required column is missing from the header', () => {
    // A header problem invalidates every row, so it is a bad request rather than a row error.
    expect(() => csvImport.parseUserCsv('name,email\nAlice,alice@example.com\n')).toThrow(/tempPassword/i)
  })

  it('throws on an empty file', () => {
    expect(() => csvImport.parseUserCsv('')).toThrow()
    expect(() => csvImport.parseUserCsv('   \n')).toThrow()
  })
})
