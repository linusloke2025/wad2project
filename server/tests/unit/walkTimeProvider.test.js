import { describe, it, expect, vi } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as walkTime from '../../src/services/walkTimeProvider.js'

// Acceptance criterion 5 and the OneMap failure modes.
//
// A walk time is either ROUTED (a real OneMap route) or ESTIMATED (straight-line distance on
// the layout). The two must never be confused, because a planner deciding whether a transition
// is feasible needs to know whether the number is real or a guess.
//
//   - Map layout  -> zones carry real lat/lng, so OneMap routing applies.
//   - Plan layout -> zones are image pixels, so distance x metresPerPixel / walking speed.
//   - Either mode -> if routing fails, fall back to an estimate STILL LABELLED as one.
//
// Caching is by zone pair, which is what keeps OneMap calls off the keystroke path: conflicts
// recompute on every assignment edit (docs/SPEC.md section 6).

const ZONES = {
  z1: { centroid: [0, 0] },
  z2: { centroid: [0, 140] }, // 140 units away from z1
}

const WALKING_SPEED = 1.4 // metres per second
const METRES_PER_PIXEL = 0.1

function planProvider(overrides = {}) {
  return walkTime.createWalkTimeProvider({
    mode: 'plan',
    zones: ZONES,
    metresPerPixel: METRES_PER_PIXEL,
    walkingSpeedMps: WALKING_SPEED,
    ...overrides,
  })
}

describe('createWalkTimeProvider — plan mode (estimated)', () => {
  it('computes duration from layout distance and scale, labelled as an estimate', async () => {
    const provider = planProvider()

    // 140 units x 0.1 m/unit = 14 m; 14 m / 1.4 m/s = 10 s
    const result = await provider.getWalkTime('z1', 'z2')

    expect(result.seconds).toBeCloseTo(10, 5)
    expect(result.source).toBe('estimate')
  })

  it('never calls the routing client in plan mode, because pixel distance is meaningless as lat/lng', async () => {
    const client = { getRouteTime: vi.fn() }
    const provider = planProvider({ client })

    await provider.getWalkTime('z1', 'z2')

    expect(client.getRouteTime).not.toHaveBeenCalled()
  })

  it('throws a clear error for an unknown zone rather than guessing a distance', async () => {
    const provider = planProvider()

    await expect(provider.getWalkTime('z1', 'ghost')).rejects.toThrow(/ghost/)
  })
})

describe('createWalkTimeProvider — map mode (routed)', () => {
  it('uses the routing client and labels the result as routed', async () => {
    const client = { getRouteTime: vi.fn(async () => ({ seconds: 420 })) }
    const provider = walkTime.createWalkTimeProvider({ mode: 'map', zones: ZONES, client })

    const result = await provider.getWalkTime('z1', 'z2')

    expect(result.seconds).toBe(420)
    expect(result.source).toBe('onemap')
    expect(client.getRouteTime).toHaveBeenCalledOnce()
  })

  it('falls back to an estimate when routing fails, and says so', async () => {
    const client = {
      getRouteTime: vi.fn(async () => {
        throw new Error('OneMap unavailable')
      }),
    }
    const provider = walkTime.createWalkTimeProvider({
      mode: 'map',
      zones: ZONES,
      client,
      metresPerPixel: METRES_PER_PIXEL,
      walkingSpeedMps: WALKING_SPEED,
    })

    const result = await provider.getWalkTime('z1', 'z2')

    // The number is a fallback, so it must NOT be presented as a real route.
    expect(result.source).toBe('estimate')
    expect(result.seconds).toBeCloseTo(10, 5)
  })
})

describe('createWalkTimeProvider — caching', () => {
  it('caches by zone pair so repeated conflict recomputation does not re-hit OneMap', async () => {
    const client = { getRouteTime: vi.fn(async () => ({ seconds: 420 })) }
    const provider = walkTime.createWalkTimeProvider({ mode: 'map', zones: ZONES, client })

    await provider.getWalkTime('z1', 'z2')
    await provider.getWalkTime('z1', 'z2')
    await provider.getWalkTime('z1', 'z2')

    expect(client.getRouteTime).toHaveBeenCalledOnce()
  })

  it('treats the pair as unordered, since walking A->B and B->A are the same length here', async () => {
    const client = { getRouteTime: vi.fn(async () => ({ seconds: 420 })) }
    const provider = walkTime.createWalkTimeProvider({ mode: 'map', zones: ZONES, client })

    await provider.getWalkTime('z1', 'z2')
    await provider.getWalkTime('z2', 'z1')

    expect(client.getRouteTime).toHaveBeenCalledOnce()
  })

  it('does not cache a failure as though it were a successful route', async () => {
    let attempt = 0
    const client = {
      getRouteTime: vi.fn(async () => {
        attempt += 1
        if (attempt === 1) throw new Error('transient')
        return { seconds: 300 }
      }),
    }
    const provider = walkTime.createWalkTimeProvider({
      mode: 'map',
      zones: ZONES,
      client,
      metresPerPixel: METRES_PER_PIXEL,
      walkingSpeedMps: WALKING_SPEED,
    })

    const first = await provider.getWalkTime('z1', 'z2')
    const second = await provider.getWalkTime('z1', 'z2')

    expect(first.source).toBe('estimate')
    // The retry actually reached OneMap and upgraded the answer to a routed time.
    expect(second.source).toBe('onemap')
    expect(second.seconds).toBe(300)
  })
})
