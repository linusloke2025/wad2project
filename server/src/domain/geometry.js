/**
 * Geometry primitives for the conflict engine.
 *
 * Layout coordinates are in the layout's own space — real lat/long for a Map layout, or image
 * pixels for a Plan layout. The maths is identical either way, which is why the conflict rules
 * can be unit-tested with plain numbers and no map provider.
 *
 * Boundary policy: a point exactly on an edge or vertex counts as INSIDE. For blocked areas
 * that is deliberately conservative — a group standing on the lip of a blocked zone is treated
 * as being in it, so the app warns rather than stays silent.
 *
 * A polygon is an array of [x, y] vertices, implicitly closed (last connects back to first).
 */

/** Cross-product sign; 0 means the three points are collinear. */
export function orientation(a, b, c) {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  return Math.sign(value)
}

/** Whether p lies within the bounding box of segment ab. Assumes collinearity. */
export function onSegment(a, b, p) {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  )
}

/**
 * Whether two segments share any point. Touching endpoints and collinear overlap both count,
 * so a path grazing a blocked area's edge is reported rather than missed.
 */
export function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = orientation(p3, p4, p1)
  const d2 = orientation(p3, p4, p2)
  const d3 = orientation(p1, p2, p3)
  const d4 = orientation(p1, p2, p4)

  const straddles = (x, y) => (x > 0 && y < 0) || (x < 0 && y > 0)

  if (straddles(d1, d2) && straddles(d3, d4)) return true

  // Collinear / touching cases.
  if (d1 === 0 && onSegment(p3, p4, p1)) return true
  if (d2 === 0 && onSegment(p3, p4, p2)) return true
  if (d3 === 0 && onSegment(p1, p2, p3)) return true
  if (d4 === 0 && onSegment(p1, p2, p4)) return true

  return false
}

/**
 * Ray-casting point-in-polygon test, with an explicit boundary pass so edge and vertex cases
 * are inside rather than dependent on floating-point luck.
 */
export function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    if (orientation(polygon[j], polygon[i], point) === 0 && onSegment(polygon[j], polygon[i], point)) {
      return true
    }
  }

  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]

    const crossesRay = yi > point[1] !== yj > point[1]
    if (crossesRay && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }

  return inside
}

/**
 * Whether two polygons overlap at all — via an edge crossing, or by one being wholly
 * contained in the other (which produces no edge crossings).
 */
export function polygonsIntersect(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) return false

  for (let i = 0; i < a.length; i += 1) {
    const a1 = a[i]
    const a2 = a[(i + 1) % a.length]
    for (let j = 0; j < b.length; j += 1) {
      const b1 = b[j]
      const b2 = b[(j + 1) % b.length]
      if (segmentsIntersect(a1, a2, b1, b2)) return true
    }
  }

  // No edge crossings: containment is the only remaining way to overlap.
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a)
}

/**
 * Whether a path segment touches a polygon's interior or boundary. A segment lying wholly
 * inside counts — a route that stays within a blocked area is still violating it.
 */
export function segmentIntersectsPolygon(p1, p2, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false

  if (pointInPolygon(p1, polygon) || pointInPolygon(p2, polygon)) return true

  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    if (segmentsIntersect(p1, p2, a, b)) return true
  }

  return false
}

/** Mean vertex position. Sufficient for routing endpoints on a zone. */
export function polygonCentroid(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return null

  let x = 0
  let y = 0
  for (const [px, py] of polygon) {
    x += px
    y += py
  }

  return [x / polygon.length, y / polygon.length]
}
