import { describe, it, expect, vi } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as broadcasterModule from '../../src/realtime/broadcaster.js'

// A one-line pub/sub between the HTTP layer and the socket layer.
//
// The route that creates an announcement must not import socket.io: that would couple an HTTP
// handler to the transport, make the route untestable without a socket, and mean a process
// without realtime (a test, a script) could not create an announcement at all. So the route
// publishes, and the socket layer subscribes.
//
// Pure, so no socket is needed to verify it.

describe('createBroadcaster', () => {
  it('delivers a published event to a subscriber', () => {
    const broadcaster = broadcasterModule.createBroadcaster()
    const listener = vi.fn()
    broadcaster.subscribe(listener)

    broadcaster.publish('announcement:created', 'e1', { id: 'a1' })

    expect(listener).toHaveBeenCalledWith('announcement:created', 'e1', { id: 'a1' })
  })

  it('delivers to every subscriber', () => {
    const broadcaster = broadcasterModule.createBroadcaster()
    const first = vi.fn()
    const second = vi.fn()
    broadcaster.subscribe(first)
    broadcaster.subscribe(second)

    broadcaster.publish('announcement:created', 'e1', { id: 'a1' })

    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('stops delivering to a subscriber that unsubscribes', () => {
    const broadcaster = broadcasterModule.createBroadcaster()
    const listener = vi.fn()
    const unsubscribe = broadcaster.subscribe(listener)

    unsubscribe()
    broadcaster.publish('announcement:created', 'e1', { id: 'a1' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('publishes harmlessly when nothing is listening', () => {
    // A process with no realtime layer must still be able to create an announcement.
    const broadcaster = broadcasterModule.createBroadcaster()

    expect(() => broadcaster.publish('announcement:created', 'e1', { id: 'a1' })).not.toThrow()
  })

  it('keeps events of different kinds separate', () => {
    const broadcaster = broadcasterModule.createBroadcaster()
    const listener = vi.fn()
    broadcaster.subscribe(listener)

    broadcaster.publish('status:changed', 'e1', { groupId: 'g1' })

    expect(listener).toHaveBeenCalledWith('status:changed', 'e1', { groupId: 'g1' })
  })
})
