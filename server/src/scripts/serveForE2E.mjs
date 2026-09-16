/**
 * Runs the end-to-end stack against an EMBEDDED MongoDB.
 *
 * Playwright launches this as its web server: it starts an in-memory mongod, seeds the fixtures,
 * and then starts the real server through the real entry point. The result is an end-to-end suite
 * that needs no Atlas cluster, no network, no `MONGODB_URI` and no IP allowlist — it runs the
 * same way on any machine and in CI.
 *
 * That matters beyond convenience. A test suite that depends on a cloud database fails whenever
 * the network, the credentials or an IP allowlist changes, and a suite that cannot run is a suite
 * nobody trusts. The application still uses Atlas; only the tests are self-contained.
 *
 * The binary is downloaded into the workspace on first use, because the default cache lives under
 * the user profile, which this environment cannot write to.
 */

// Must be set before mongodb-memory-server is imported: it reads this at module load.
//
// fileURLToPath rather than URL.pathname: the latter yields a percent-encoded path with a leading
// slash ("/D:/C%20Redirected/..."), which on Windows becomes a malformed "D:\D:\C%20Redirected\...".
import { fileURLToPath } from 'node:url'

process.env.MONGOMS_DOWNLOAD_DIR =
  process.env.MONGOMS_DOWNLOAD_DIR ?? fileURLToPath(new URL('../../.mongodb-binaries/', import.meta.url))

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'e2e-only-secret-not-for-any-real-use'
process.env.PORT = process.env.PORT ?? '3100'

const { MongoMemoryServer } = await import('mongodb-memory-server')

console.log('[e2e] starting an in-memory MongoDB (first run downloads a binary)')
const mongo = await MongoMemoryServer.create({ instance: { dbName: 'wad2-e2e' } })
const uri = mongo.getUri('wad2-e2e')
console.log('[e2e] in-memory MongoDB ready')

// Set before importing the server: the real entry point reads configuration from the environment,
// and dotenv never overwrites a variable that is already set, so this wins over server/.env.
process.env.MONGODB_URI = uri

const { startServer } = await import('../server.js')
const { seedE2E } = await import('./seedE2E.js')

await startServer()

// The server connects before it listens, so seeding here is safely after the connection.
// The database name ends in -e2e, so seedE2E's own guard accepts it.
await seedE2E({ uri })
console.log('[e2e] fixtures seeded')

/** Stop the embedded database when Playwright shuts this process down. */
async function shutdown() {
  await mongo.stop().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
