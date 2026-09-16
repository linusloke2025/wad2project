/**
 * Deterministic fixtures for the end-to-end run.
 *
 * Two safety properties matter here:
 *
 * 1. It refuses to run against a database that does not look like an E2E database. The
 *    Playwright run starts from the same MONGODB_URI the app uses, so a config typo would
 *    otherwise seed test accounts and events into the real data.
 *
 * 2. It is idempotent. Playwright's global setup may run repeatedly, and creating a second root
 *    or duplicate event each time would make the suite flaky in a way that looks like a product
 *    bug.
 */

import mongoose from 'mongoose'

import { hashPassword } from '../auth/passwords.js'
import { createMongooseRepositories } from '../repositories/mongooseRepositories.js'
import {
  E2E_COMMUNITY_NAME,
  E2E_EVENT_NAME,
  E2E_PASSWORD,
  E2E_ROLES,
  E2E_TEMP_ACCOUNT,
  E2E_TEMP_PASSWORD,
  E2E_USERS,
} from './e2eFixtures.js'

export {
  E2E_COMMUNITY_NAME,
  E2E_EVENT_NAME,
  E2E_PASSWORD,
  E2E_ROLES,
  E2E_TEMP_ACCOUNT,
  E2E_TEMP_PASSWORD,
  E2E_USERS,
  E2E_ZONE_NAMES,
} from './e2eFixtures.js'

/** @throws when the target database does not look like an E2E database */
export function assertE2eDatabase(uri, { force = false } = {}) {
  if (force) return

  // Compare only the path segment, so a host containing 'e2e' cannot pass by accident.
  const withoutQuery = uri.split('?')[0]
  const database = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1)

  if (!database.endsWith('-e2e')) {
    throw new Error(
      `Refusing to seed: database "${database}" does not end in "-e2e". ` +
        'End-to-end fixtures must not land in the application database.',
    )
  }
}

/**
 * @param {{uri: string, force?: boolean}} options
 * @returns {Promise<{communityId: string, eventId: string, userIds: Record<string, string>}>}
 */
export async function seedE2E({ uri, force = false }) {
  assertE2eDatabase(uri, { force })

  const alreadyConnected = mongoose.connection.readyState === 1
  if (!alreadyConnected) {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 })
  }

  const repositories = createMongooseRepositories()

  // --- community -----------------------------------------------------------------------
  let community = await mongoose.connection.collection('communities').findOne({ name: E2E_COMMUNITY_NAME })
  if (!community) {
    const created = await repositories.communities.create({ name: E2E_COMMUNITY_NAME })
    community = { _id: new mongoose.Types.ObjectId(created.id) }
  }
  const communityId = String(community._id)

  // One hash reused across fixtures: bcrypt is deliberately slow, and hashing the same password
  // seven times would add seconds to every run for no benefit. The temp account differs, so it
  // gets its own.
  const sharedHash = await hashPassword(E2E_PASSWORD)
  const tempHash = await hashPassword(E2E_TEMP_PASSWORD)

  const userIds = {}
  for (const [persona, email] of Object.entries(E2E_USERS)) {
    const role = E2E_ROLES[persona]
    if (!role) throw new Error(`No role mapped for E2E persona "${persona}"`)

    const isTemp = email === E2E_TEMP_ACCOUNT

    let user = await repositories.users.findByEmail(email)
    if (!user) {
      user = await repositories.users.create({
        email,
        name: `E2E ${persona}`,
        passwordHash: isTemp ? tempHash : sharedHash,
        // Everyone except the temp account can go straight to work; the temp account exists
        // precisely so the forced-change journey has something to exercise.
        mustChangePassword: isTemp,
      })
    }
    userIds[persona] = user.id

    const existing = await repositories.memberships.find(user.id, communityId)
    if (!existing) {
      await repositories.memberships.create({ userId: user.id, communityId, role })
    }
  }

  // --- event ---------------------------------------------------------------------------
  let event = await mongoose.connection.collection('events').findOne({ name: E2E_EVENT_NAME })
  if (!event) {
    const created = await repositories.events.create({
      communityId,
      name: E2E_EVENT_NAME,
      start: new Date('2026-03-01T09:00:00+08:00'),
      end: new Date('2026-03-01T12:00:00+08:00'),
      // A plan layout keeps the suite off the OneMap network, so the run does not depend on a
      // third party being reachable.
      layoutMode: 'plan',
      metresPerPixel: 0.1,
      createdBy: userIds.root,
    })
    event = { _id: new mongoose.Types.ObjectId(created.id) }
  }
  const eventId = String(event._id)

  // --- zones ---------------------------------------------------------------------------
  const existingZones = await repositories.zones.listByEvent(eventId)
  if (existingZones.length === 0) {
    await repositories.zones.create({
      eventId, name: 'Main Stage', kind: 'zone',
      polygon: [[0, 0], [10, 0], [10, 10], [0, 10]],
    })
    await repositories.zones.create({
      eventId, name: 'Holding Area', kind: 'zone',
      polygon: [[0, 140], [10, 140], [10, 150], [0, 150]],
    })
    await repositories.zones.create({
      eventId, name: 'Closed for works', kind: 'blocked',
      polygon: [[5, 5], [15, 5], [15, 15], [5, 15]],
    })
  }

  // --- groups --------------------------------------------------------------------------
  const existingGroups = await repositories.groups.listByEvent(eventId)
  if (existingGroups.length === 0) {
    await repositories.groups.create({ eventId, name: 'Group A', leadUserId: userIds.lead })
    await repositories.groups.create({ eventId, name: 'Group B', leadUserId: null })
  }

  if (!alreadyConnected) {
    await mongoose.disconnect()
  }

  return { communityId, eventId, userIds }
}
