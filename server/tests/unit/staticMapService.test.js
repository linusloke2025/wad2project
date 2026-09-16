import { describe, it, expect, vi } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as staticMap from '../../src/services/staticMapService.js'

// OneMap Static Map integration for Map-layout events.
//
// Every encoding rule below was verified against the LIVE OneMap endpoint before being written
// as an assertion, because OneMap's own documentation is self-contradictory:
//
//   Docs prose: "Polygon(s) and its color are segregated by semicolon. Whereas each polygon is
//                differentiated with a pipe."
//   Live result: semicolon -> {"error":"Please provide valid polygons."} ; pipe -> image/png
//
// Also verified live: the API needs NO authentication (identical 224KB PNG with and without a
// bearer token), so no credential ever needs to reach this code path.
//
// And the trap: OneMap signals some failures with HTTP 200 and a JSON body. Checking only
// `response.ok` would treat a 47-byte error string as a map image.

const ZONE = {
  id: 'z1',
  kind: 'zone',
  polygon: [
    [1.32, 103.84],
    [1.31, 103.84],
    [1.31, 103.83],
    [1.32, 103.83],
  ],
}

const BLOCKED = {
  id: 'b1',
  kind: 'blocked',
  polygon: [
    [1.315, 103.845],
    [1.314, 103.845],
    [1.314, 103.844],
  ],
}

const EVENT_COORDS = { latitude: 1.31955, longitude: 103.84223 }

const imageResponse = () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'image/png' },
  arrayBuffer: async () => new ArrayBuffer(1024),
})

// The exact shape the live API returned for an invalid polygon list: HTTP 200, JSON body.
const jsonErrorWith200 = () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json; charset=utf-8' },
  json: async () => ({ error: 'Please provide valid polygons.' }),
})

describe('buildStaticMapUrl — request shape', () => {
  it('includes the base parameters OneMap expects', () => {
    const { url } = staticMap.buildStaticMapUrl({ zones: [ZONE], ...EVENT_COORDS })

    expect(url).toContain('/api/staticmap/getStaticImage?')
    expect(url).toContain('layerchosen=default')
    expect(url).toContain('latitude=1.31955')
    expect(url).toContain('longitude=103.84223')
    expect(url).toContain('zoom=')
    expect(url).toContain('width=')
    expect(url).toContain('height=')
  })

  it('reports no omission when under the polygon cap', () => {
    const { omittedShapes } = staticMap.buildStaticMapUrl({ zones: [ZONE], ...EVENT_COORDS })

    expect(omittedShapes).toBe(0)
  })
})

describe('buildStaticMapUrl — OneMap resolution limit', () => {
  // Verified against the live API: 640x480 returns HTTP 400 with
  // {"error":"The maximum resolution size is 512 x 512."} while 512x512 returns a PNG.
  //
  // This was a real bug: the original 640x480 default was rejected on EVERY request, so each
  // Map layout degraded to the placeholder and looked like OneMap being down. The failure
  // arrives as a 400 here but as a 200 elsewhere, so only the content-type check caught it.

  it('keeps the default dimensions within the maximum', () => {
    const { url } = staticMap.buildStaticMapUrl({ zones: [], ...EVENT_COORDS })

    expect(Number(/width=(\d+)/.exec(url)[1])).toBeLessThanOrEqual(staticMap.MAX_DIMENSION)
    expect(Number(/height=(\d+)/.exec(url)[1])).toBeLessThanOrEqual(staticMap.MAX_DIMENSION)
  })

  it('clamps an oversized dimension rather than sending a request that can only fail', () => {
    const { url } = staticMap.buildStaticMapUrl({ zones: [], ...EVENT_COORDS, width: 1200, height: 900 })

    expect(Number(/width=(\d+)/.exec(url)[1])).toBe(staticMap.MAX_DIMENSION)
    expect(Number(/height=(\d+)/.exec(url)[1])).toBe(staticMap.MAX_DIMENSION)
  })

  it('leaves a dimension under the limit untouched', () => {
    const { url } = staticMap.buildStaticMapUrl({ zones: [], ...EVENT_COORDS, width: 400, height: 300 })

    expect(Number(/width=(\d+)/.exec(url)[1])).toBe(400)
    expect(Number(/height=(\d+)/.exec(url)[1])).toBe(300)
  })
})

describe('buildStaticMapUrl — polygon encoding', () => {
  it('closes the ring, because OneMap requires the start and end point to match', () => {
    const { url } = staticMap.buildStaticMapUrl({ zones: [ZONE], ...EVENT_COORDS })

    // ZONE has 4 distinct points; the encoded ring must have 5, with the first repeated.
    expect(url).toContain('[[1.32,103.84],[1.31,103.84],[1.31,103.83],[1.32,103.83],[1.32,103.84]]')
  })

  it('does not duplicate an already-closed ring', () => {
    const closed = { ...ZONE, polygon: [...ZONE.polygon, ZONE.polygon[0]] }
    const { url } = staticMap.buildStaticMapUrl({ zones: [closed], ...EVENT_COORDS })

    expect(url).toContain('[[1.32,103.84],[1.31,103.84],[1.31,103.83],[1.32,103.83],[1.32,103.84]]:')
    // One closing point, not two.
    expect(url.match(/1\.32,103\.84/g)).toHaveLength(2)
  })

  it('separates multiple polygons with a pipe, never a semicolon', () => {
    const { url } = staticMap.buildStaticMapUrl({ zones: [ZONE, BLOCKED], ...EVENT_COORDS })

    // Verified live: a semicolon makes OneMap reject the whole request.
    expect(url).toContain('%7C')
    expect(decodeURIComponent(url)).not.toContain(';')
  })

  it('draws zones and blocked areas in different colours', () => {
    const zones = staticMap.buildStaticMapUrl({ zones: [ZONE], ...EVENT_COORDS }).url
    const blocked = staticMap.buildStaticMapUrl({ zones: [BLOCKED], ...EVENT_COORDS }).url

    expect(zones).toContain(`:${staticMap.ZONE_COLOUR.join(',')}`)
    expect(blocked).toContain(`:${staticMap.BLOCKED_COLOUR.join(',')}`)
    expect(staticMap.BLOCKED_COLOUR).toEqual([255, 0, 0])
  })

  it('ignores shapes that are not drawable polygons', () => {
    const degenerate = { id: 'x', kind: 'zone', polygon: [[1.32, 103.84], [1.31, 103.84]] }
    const { url } = staticMap.buildStaticMapUrl({ zones: [ZONE, degenerate], ...EVENT_COORDS })

    expect(url.match(/%7C/g) ?? []).toHaveLength(0)
  })
})

describe('buildStaticMapUrl — the 20 polygon cap', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `z${i}`,
    kind: 'zone',
    polygon: [
      [1.32 + i * 0.0001, 103.84],
      [1.31 + i * 0.0001, 103.84],
      [1.31 + i * 0.0001, 103.83],
    ],
  }))

  it('sends at most the cap and reports how many shapes were dropped', () => {
    const { url, omittedShapes } = staticMap.buildStaticMapUrl({ zones: many, ...EVENT_COORDS })

    expect(omittedShapes).toBe(25 - staticMap.MAX_POLYGONS)
    // cap polygons => cap-1 separators
    expect(url.match(/%7C/g)).toHaveLength(staticMap.MAX_POLYGONS - 1)
  })
})

describe('createStaticMapService — success', () => {
  it('returns the OneMap URL when OneMap serves an image', async () => {
    const fetchImpl = vi.fn(async () => imageResponse())
    const service = staticMap.createStaticMapService({ fetchImpl })

    const result = await service.forEvent({
      event: { layoutMode: 'map', ...EVENT_COORDS },
      zones: [ZONE],
    })

    expect(result.warning).toBeNull()
    expect(result.imageUrl).toContain('/api/staticmap/getStaticImage')
    expect(result.omittedShapes).toBe(0)
  })

  it('does not call OneMap at all for a Plan-layout event', async () => {
    const fetchImpl = vi.fn(async () => imageResponse())
    const service = staticMap.createStaticMapService({ fetchImpl })

    const result = await service.forEvent({ event: { layoutMode: 'plan' }, zones: [ZONE] })

    // Plan layouts are image pixels; a lat/lng map is meaningless for them.
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.imageUrl).toBeNull()
  })
})

describe('createStaticMapService — failure degradation', () => {
  it('treats a JSON body on an HTTP 200 as a failure, not an image', async () => {
    const fetchImpl = vi.fn(async () => jsonErrorWith200())
    const service = staticMap.createStaticMapService({ fetchImpl })

    const result = await service.forEvent({
      event: { layoutMode: 'map', ...EVENT_COORDS },
      zones: [ZONE],
    })

    // This is the trap: response.ok is true, yet the body is an error document.
    expect(result.imageUrl).toBe(staticMap.PLACEHOLDER_MAP_IMAGE)
    expect(result.warning).toMatch(/unavailable/i)
  })

  it('degrades when the request throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const service = staticMap.createStaticMapService({ fetchImpl })

    const result = await service.forEvent({
      event: { layoutMode: 'map', ...EVENT_COORDS },
      zones: [ZONE],
    })

    expect(result.imageUrl).toBe(staticMap.PLACEHOLDER_MAP_IMAGE)
    expect(result.warning).toMatch(/unavailable/i)
  })

  it('degrades when the event has no coordinates to centre the map on', async () => {
    const fetchImpl = vi.fn(async () => imageResponse())
    const service = staticMap.createStaticMapService({ fetchImpl })

    const result = await service.forEvent({ event: { layoutMode: 'map' }, zones: [ZONE] })

    expect(result.imageUrl).toBe(staticMap.PLACEHOLDER_MAP_IMAGE)
    expect(result.warning).toMatch(/coordinate/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('still reports omitted shapes when the map itself fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const service = staticMap.createStaticMapService({ fetchImpl })
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `z${i}`,
      kind: 'zone',
      polygon: [
        [1.32 + i * 0.0001, 103.84],
        [1.31 + i * 0.0001, 103.84],
        [1.31 + i * 0.0001, 103.83],
      ],
    }))

    const result = await service.forEvent({
      event: { layoutMode: 'map', ...EVENT_COORDS },
      zones: many,
    })

    // A partial map that also failed is still partially explained.
    expect(result.omittedShapes).toBe(5)
  })
})
