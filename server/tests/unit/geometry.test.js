import { describe, it, expect } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as geometry from '../../src/domain/geometry.js'

// Geometry primitives backing conflict rule 3 (blocked-area violation).
//
// Layout coordinates are in the layout's own space: real lat/long for a Map layout, or image
// pixels for a Plan layout. The maths is identical either way, which is why the rules can be
// tested with plain numbers.
//
// Boundary policy: a point exactly on an edge or vertex counts as INSIDE. For blocked areas
// that is the conservative choice — a group standing on the lip of a blocked zone is treated
// as being in it, so the app warns rather than stays silent.

const SQUARE = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
]

describe('pointInPolygon', () => {
  it('detects a point inside', () => {
    expect(geometry.pointInPolygon([5, 5], SQUARE)).toBe(true)
  })

  it('detects a point outside', () => {
    expect(geometry.pointInPolygon([15, 5], SQUARE)).toBe(false)
    expect(geometry.pointInPolygon([5, -1], SQUARE)).toBe(false)
  })

  it('treats a point on an edge or vertex as inside', () => {
    expect(geometry.pointInPolygon([0, 5], SQUARE)).toBe(true)
    expect(geometry.pointInPolygon([0, 0], SQUARE)).toBe(true)
    expect(geometry.pointInPolygon([10, 10], SQUARE)).toBe(true)
  })

  it('handles a concave polygon without leaking outside the notch', () => {
    const concave = [
      [0, 0],
      [10, 0],
      [10, 10],
      [5, 5],
      [0, 10],
    ]
    expect(geometry.pointInPolygon([5, 2], concave)).toBe(true)
    expect(geometry.pointInPolygon([5, 8], concave)).toBe(false)
  })
})

describe('segmentsIntersect', () => {
  it('detects a proper crossing', () => {
    expect(geometry.segmentsIntersect([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true)
  })

  it('detects disjoint segments', () => {
    expect(geometry.segmentsIntersect([0, 0], [1, 1], [5, 5], [6, 6])).toBe(false)
  })

  it('detects touching endpoints', () => {
    expect(geometry.segmentsIntersect([0, 0], [5, 5], [5, 5], [10, 0])).toBe(true)
  })

  it('does not treat parallel non-collinear segments as intersecting', () => {
    expect(geometry.segmentsIntersect([0, 0], [10, 0], [0, 1], [10, 1])).toBe(false)
  })

  it('detects collinear overlap', () => {
    expect(geometry.segmentsIntersect([0, 0], [10, 0], [5, 0], [15, 0])).toBe(true)
  })
})

describe('polygonsIntersect', () => {
  const shifted = (dx, dy) => SQUARE.map(([x, y]) => [x + dx, y + dy])

  it('detects overlapping polygons', () => {
    expect(geometry.polygonsIntersect(SQUARE, shifted(5, 5))).toBe(true)
  })

  it('detects disjoint polygons', () => {
    expect(geometry.polygonsIntersect(SQUARE, shifted(20, 20))).toBe(false)
  })

  it('detects a polygon fully contained in another', () => {
    const inner = [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 4],
    ]
    expect(geometry.polygonsIntersect(SQUARE, inner)).toBe(true)
    expect(geometry.polygonsIntersect(inner, SQUARE)).toBe(true)
  })

  it('detects edge-touching polygons', () => {
    expect(geometry.polygonsIntersect(SQUARE, shifted(10, 0))).toBe(true)
  })
})

describe('segmentIntersectsPolygon', () => {
  it('detects a segment crossing the polygon', () => {
    expect(geometry.segmentIntersectsPolygon([-5, 5], [15, 5], SQUARE)).toBe(true)
  })

  it('detects a segment lying entirely inside the polygon', () => {
    expect(geometry.segmentIntersectsPolygon([2, 2], [8, 8], SQUARE)).toBe(true)
  })

  it('detects a segment entirely outside the polygon', () => {
    expect(geometry.segmentIntersectsPolygon([-5, -5], [-1, -1], SQUARE)).toBe(false)
    expect(geometry.segmentIntersectsPolygon([20, 20], [30, 30], SQUARE)).toBe(false)
  })
})

describe('polygonCentroid', () => {
  it('returns the mean vertex position', () => {
    expect(geometry.polygonCentroid(SQUARE)).toEqual([5, 5])
  })

  it('handles a triangle', () => {
    expect(geometry.polygonCentroid([[0, 0], [6, 0], [0, 3]])).toEqual([2, 1])
  })
})
