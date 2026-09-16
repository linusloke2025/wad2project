/**
 * Server entry point.
 *
 * Wires configuration, MongoDB, the Mongoose-backed repositories, auth, the conflict engine and
 * the OneMap services into one process, then listens.
 *
 * Exported as `startServer` so it can be exercised without spawning a process — the failure path
 * in particular, which must name the missing variable and stop rather than half-start.
 */

import 'dotenv/config'
import http from 'node:http'
import mongoose from 'mongoose'

import { createApp } from './app.js'
import { createTokenService } from './auth/tokens.js'
import { loadConfig } from './config.js'
import { createBroadcaster } from './realtime/broadcaster.js'
import { createLiveState } from './realtime/liveState.js'
import { createRealtimeServer } from './realtime/socketServer.js'
import { createMongooseRepositories } from './repositories/mongooseRepositories.js'
import { createConflictService } from './services/conflictService.js'
import { createOneMapClient } from './services/onemapClient.js'
import { createStaticMapService } from './services/staticMapService.js'

/**
 * @param {{env?: Record<string, string|undefined>}} [options]
 * @returns {Promise<import('node:http').Server>}
 */
export async function startServer({ env = process.env } = {}) {
  const config = loadConfig(env)

  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 10000 })

  // Optional on purpose: without credentials, Map-layout walk times are estimated instead of
  // routed. The static map needs no credentials either way.
  const onemapClient = config.hasOneMapRouting
    ? createOneMapClient({ email: config.onemapEmail, password: config.onemapPassword })
    : null

  const tokenService = createTokenService({ secret: config.jwtSecret })
  const repositories = createMongooseRepositories()
  // One store shared by the Socket.IO layer and the HTTP live-snapshot route, so a reconnecting
  // client resyncs against the same view it was receiving.
  const liveState = createLiveState()
  // One publisher shared by the HTTP routes and the socket layer, so an announcement authored
  // over HTTP reaches the event's socket room.
  const broadcaster = createBroadcaster()

  const app = createApp({
    tokenService,
    repositories,
    conflictService: createConflictService({ onemapClient }),
    staticMapService: createStaticMapService(),
    liveState,
    broadcaster,
  })

  const httpServer = http.createServer(app)
  createRealtimeServer({ httpServer, tokenService, repositories, liveState, broadcaster })

  return httpServer.listen(config.port, () => {
    console.log(`Listening on http://localhost:${config.port}`)
    console.log(
      onemapClient
        ? 'OneMap routing: enabled — Map layouts use real walking times'
        : 'OneMap routing: disabled — Map layouts estimate walking times',
    )
  })
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  startServer().catch((error) => {
    console.error(`Startup failed: ${error.message}`)
    process.exitCode = 1
  })
}
