/**
 * A minimal publish/subscribe seam between the HTTP layer and the socket layer.
 *
 * The route that creates an announcement must not import socket.io. Coupling an HTTP handler to
 * the transport would make the route untestable without a socket, and would mean a process with
 * no realtime layer — a script, a test, a future worker — could not create an announcement at
 * all. So the route publishes; the socket layer subscribes if it exists.
 *
 * Deliberately tiny: one Set, no wildcards, no ordering guarantees beyond insertion order. If it
 * ever needs more than this, that is a signal to reach for a real event bus rather than to grow
 * this file.
 */

export function createBroadcaster() {
  /** @type {Set<(event: string, eventId: string, payload: object) => void>} */
  const listeners = new Set()

  return {
    /**
     * @param {(event: string, eventId: string, payload: object) => void} listener
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /**
     * Publishing with nothing listening is a normal, harmless case — not an error.
     */
    publish(event, eventId, payload) {
      // Iterate a copy so a listener that unsubscribes mid-publish cannot skip the next one.
      for (const listener of [...listeners]) {
        listener(event, eventId, payload)
      }
    },
  }
}
