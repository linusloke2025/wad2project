/**
 * OneMap Static Map integration for Map-layout events.
 *
 * Every rule here was verified against the LIVE OneMap endpoint, because OneMap's own
 * documentation is self-contradictory and would lead a careful reader into a bug:
 *
 *   Docs prose: "Polygon(s) and its color are segregated by semicolon. Whereas each polygon is
 *                differentiated with a pipe."
 *   Live result: semicolon -> HTTP 200 + {"error":"Please provide valid polygons."}
 *                pipe     -> HTTP 200 + image/png, and the image actually changes when a
 *                            second polygon is added inside the viewport.
 *
 * So: PIPE separates polygons, a COLON precedes the colour, and the ring must be closed. Do not
 * "correct" the pipe to a semicolon on the strength of the prose.
 *
 * Two further live findings shape this module:
 *
 * 1. NO AUTHENTICATION IS NEEDED. The same request returns an identical 224KB PNG with and
 *    without a bearer token. No credential therefore reaches this code path at all, which is why
 *    the no-key-leak guarantee here is structural rather than a matter of care.
 *
 * 2. FAILURES CAN ARRIVE AS HTTP 200 WITH A JSON BODY. Checking only `response.ok` would store a
 *    47-byte error document as the map image, so the content type is the reliable signal.
 */

const DEFAULT_BASE_URL = 'https://www.onemap.gov.sg'
const COORD_PRECISION = 6
const DEFAULT_ZOOM = 17
const DEFAULT_WIDTH = 640
const DEFAULT_HEIGHT = 480
const DEFAULT_LAYER = 'default'

/** Cap on shapes per request: polygons ride in the query string, which has length limits. */
export const MAX_POLYGONS = 20

export const ZONE_COLOUR = [0, 122, 255]
export const BLOCKED_COLOUR = [255, 0, 0]

/** Shown instead of a map when OneMap cannot be used; the UI pairs it with the warning text. */
export const PLACEHOLDER_MAP_IMAGE =
  'data:image/svg+xml;utf8,' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">' +
  '<rect width="100%" height="100%" fill="%23eef1f5"/>' +
  '<text x="50%" y="50%" text-anchor="middle" fill="%23707a87" font-family="sans-serif" font-size="18">' +
  'Map unavailable' +
  '</text></svg>'

function roundCoordinate(value) {
  return Number(value.toFixed(COORD_PRECISION))
}

function isDrawable(polygon) {
  return (
    Array.isArray(polygon) &&
    polygon.length >= 3 &&
    polygon.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1]),
    )
  )
}

/**
 * Encode one polygon as `[[lat,lng],...]:r,g,b`, closing the ring.
 *
 * OneMap requires the start and end points to match, so an open ring is closed here rather than
 * being rejected by the API.
 */
function formatPolygon(polygon, colour) {
  const points = polygon.map(([lat, lng]) => [roundCoordinate(lat), roundCoordinate(lng)])

  const first = points[0]
  const last = points[points.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) {
    points.push([first[0], first[1]])
  }

  const coordinates = points.map(([lat, lng]) => `[${lat},${lng}]`).join(',')
  return `[${coordinates}]:${colour.join(',')}`
}

/**
 * @returns {{url: string, omittedShapes: number}}
 */
export function buildStaticMapUrl({
  zones = [],
  latitude,
  longitude,
  zoom = DEFAULT_ZOOM,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  layer = DEFAULT_LAYER,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  const drawable = zones.filter((zone) => isDrawable(zone.polygon))
  const used = drawable.slice(0, MAX_POLYGONS)
  const omittedShapes = drawable.length - used.length

  const params = [
    `layerchosen=${layer}`,
    `latitude=${latitude}`,
    `longitude=${longitude}`,
    `zoom=${zoom}`,
    `width=${width}`,
    `height=${height}`,
  ]

  if (used.length > 0) {
    const encoded = used.map((zone) =>
      formatPolygon(zone.polygon, zone.kind === 'blocked' ? BLOCKED_COLOUR : ZONE_COLOUR),
    )
    // %7C is the encoded pipe — the only separator OneMap accepts between polygons.
    params.push(`polygons=${encoded.join('%7C')}`)
  }

  return {
    url: `${baseUrl}/api/staticmap/getStaticImage?${params.join('&')}`,
    omittedShapes,
  }
}

/**
 * Resolve the map for one event.
 *
 * Plan-layout events return `imageUrl: null` and never touch the network: their zones are image
 * pixels, so a lat/lng map is meaningless for them and they keep their uploaded floor plan.
 *
 * @returns {Promise<{imageUrl: string|null, warning: string|null, omittedShapes: number}>}
 */
export function createStaticMapService({
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  async function forEvent({ event = {}, zones = [] } = {}) {
    if (event.layoutMode !== 'map') {
      return { imageUrl: null, warning: null, omittedShapes: 0 }
    }

    if (!Number.isFinite(event.latitude) || !Number.isFinite(event.longitude)) {
      // Without a centre there is no map to build — say so rather than request a wrong one.
      return {
        imageUrl: PLACEHOLDER_MAP_IMAGE,
        warning: 'Map unavailable: the event has no coordinates',
        omittedShapes: 0,
      }
    }

    const { url, omittedShapes } = buildStaticMapUrl({
      zones,
      latitude: event.latitude,
      longitude: event.longitude,
      zoom: event.zoom ?? DEFAULT_ZOOM,
      baseUrl,
    })

    try {
      const response = await fetchImpl(url)
      const contentType = response?.headers?.get?.('content-type') ?? ''

      // Content type, not response.ok: OneMap returns some failures as HTTP 200 + JSON.
      if (!contentType.startsWith('image')) {
        return { imageUrl: PLACEHOLDER_MAP_IMAGE, warning: 'Map unavailable from OneMap', omittedShapes }
      }

      return { imageUrl: url, warning: null, omittedShapes }
    } catch {
      return { imageUrl: PLACEHOLDER_MAP_IMAGE, warning: 'Map unavailable from OneMap', omittedShapes }
    }
  }

  return { forEvent }
}
