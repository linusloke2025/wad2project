/**
 * Playwright global setup: seed the E2E database before any spec runs.
 *
 * Runs once per invocation, so `seedE2E` must be idempotent — otherwise the second run creates a
 * duplicate event and the specs that count things start failing for no product reason.
 */
export default async function globalSetup() {
  const uri = process.env.E2E_MONGODB_URI

  if (!uri) {
    throw new Error('E2E_MONGODB_URI was not set — check playwright.config.js')
  }

  // Imported here rather than at module load so mongoose is only pulled in when seeding runs.
  const { resetE2E, seedE2E } = await import('../../server/src/scripts/seedE2E.js')

  // Reset first: the journeys mutate the fixture event, so without this each run starts from
  // whatever the previous one left behind and a negative assertion eventually fails on
  // leftover data rather than on a defect.
  await resetE2E({ uri })
  const seeded = await seedE2E({ uri })

  console.log(`[e2e] seeded event ${seeded.eventId} in the e2e database`)
}
