import { io } from 'socket.io-client'

/**
 * Socket.IO connection factory.
 *
 * Connects to the current origin rather than an absolute URL: the Vite dev server proxies
 * `/socket.io` to the API, and in production Express serves both the client and the socket
 * endpoint. One code path, so a bug in the proxy shows up in development instead of only after
 * deployment.
 *
 * Reconnection is left on. A dropped socket is expected on a phone moving between towers, and
 * the board resyncs over HTTP on reconnect rather than assuming it missed nothing.
 */
export function createSocket({ token }) {
  return io({
    auth: { token },
    // WebSocket first, with polling as the fallback for networks that block upgrades.
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  })
}
