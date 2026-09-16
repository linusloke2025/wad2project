import { describe, it, expect } from 'vitest'
import mongoose from 'mongoose'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as serialize from '../../src/repositories/serialize.js'

// Document serialisation: the seam between Mongoose documents and the plain objects the rest of
// the app expects.
//
// Two mismatches have to be reconciled here, and both are the kind that fail quietly:
//
//   1. Mongo calls it `_id`; every layer above calls it `id`.
//   2. Mongoose stores dates as `Date` objects, while the conflict engine is written against
//      ISO strings. `Date.parse` happens to accept a Date via string coercion, so passing a
//      Date through would *appear* to work while depending on an implicit conversion — and the
//      engine's sorting and gap arithmetic would silently depend on it.
//
// These run with no database: the mapping is pure.

const oid = () => new mongoose.Types.ObjectId()

describe('toDto — identity', () => {
  it('maps _id to a string id', () => {
    const id = oid()
    const dto = serialize.toDto({ _id: id, name: 'Parade' })

    expect(dto.id).toBe(String(id))
    expect(dto._id).toBeUndefined()
    expect(dto.name).toBe('Parade')
  })

  it('converts ObjectId reference fields to strings rather than nesting their internals', () => {
    // A naive recursive walk would spread an ObjectId's internal buffer into the output.
    const eventId = oid()
    const dto = serialize.toDto({ _id: oid(), eventId })

    expect(typeof dto.eventId).toBe('string')
    expect(dto.eventId).toBe(String(eventId))
    expect(dto.eventId).toHaveLength(24)
  })

  it('returns null for null and undefined', () => {
    expect(serialize.toDto(null)).toBeNull()
    expect(serialize.toDto(undefined)).toBeNull()
  })
})

describe('toDto — dates', () => {
  it('converts Date values to ISO strings', () => {
    const start = new Date('2026-03-01T09:00:00+08:00')
    const dto = serialize.toDto({ _id: oid(), start })

    expect(typeof dto.start).toBe('string')
    expect(dto.start).toBe(start.toISOString())
  })

  it('produces dates the conflict engine can parse', () => {
    const dto = serialize.toDto({ _id: oid(), start: new Date('2026-03-01T09:00:00+08:00') })

    expect(Number.isNaN(Date.parse(dto.start))).toBe(false)
  })

  it('converts dates nested inside arrays and objects', () => {
    const at = new Date('2026-03-01T09:00:00+08:00')
    const dto = serialize.toDto({ _id: oid(), pings: [{ at }], meta: { recordedAt: at } })

    expect(typeof dto.pings[0].at).toBe('string')
    expect(typeof dto.meta.recordedAt).toBe('string')
  })
})

describe('toDto — shape preservation', () => {
  it('leaves a polygon untouched, as an array of coordinate pairs', () => {
    const polygon = [[1.32, 103.84], [1.31, 103.84], [1.31, 103.83]]
    const dto = serialize.toDto({ _id: oid(), polygon })

    expect(dto.polygon).toEqual(polygon)
    expect(Array.isArray(dto.polygon[0])).toBe(true)
    expect(typeof dto.polygon[0][0]).toBe('number')
  })

  it('keeps numbers, strings, booleans and nulls as they are', () => {
    const dto = serialize.toDto({ _id: oid(), zoom: 17, name: 'x', live: true, lead: null })

    expect(dto).toMatchObject({ zoom: 17, name: 'x', live: true, lead: null })
  })

  it('omits the Mongo version key, which is storage detail rather than data', () => {
    const dto = serialize.toDto({ _id: oid(), name: 'x', __v: 3 })

    expect(dto.__v).toBeUndefined()
  })

  it('does not mutate the input', () => {
    const input = { _id: oid(), start: new Date('2026-03-01T09:00:00+08:00'), nested: { at: 1 } }
    const before = JSON.stringify(input)

    serialize.toDto(input)

    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('toDto — real Mongoose documents', () => {
  it('accepts a document from a model, not just a plain object', async () => {
    const { Zone } = await import('../../src/models/index.js')
    const zone = new Zone({ eventId: oid(), name: 'Main Stage', polygon: [[1, 2], [3, 4], [5, 6]] })

    const dto = serialize.toDto(zone)

    expect(typeof dto.id).toBe('string')
    expect(dto.name).toBe('Main Stage')
    expect(dto.polygon).toEqual([[1, 2], [3, 4], [5, 6]])
    expect(typeof dto.eventId).toBe('string')
  })
})

describe('toDtoList', () => {
  it('maps every document in a list', () => {
    const list = serialize.toDtoList([{ _id: oid(), name: 'a' }, { _id: oid(), name: 'b' }])

    expect(list).toHaveLength(2)
    expect(list.map((entry) => entry.name)).toEqual(['a', 'b'])
    expect(list.every((entry) => typeof entry.id === 'string')).toBe(true)
  })

  it('returns an empty list for null, so callers need no guard', () => {
    expect(serialize.toDtoList(null)).toEqual([])
    expect(serialize.toDtoList(undefined)).toEqual([])
  })
})
