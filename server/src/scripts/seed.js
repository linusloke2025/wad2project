/**
 * Seed script: creates the first root account and its community.
 *
 * The app has no public sign-up (docs/SPEC.md section 5.1), so this is how a fresh deployment
 * gets its first human. It is deliberately idempotent — running it twice must not create a second
 * root or a duplicate community.
 *
 * Input is validated before anything is written. A half-seeded database is worse than an empty
 * one: a root account with no membership cannot log in at all, because login requires a
 * membership to resolve a role, and that failure looks like a broken app rather than a broken
 * setup.
 */

import 'dotenv/config'
import mongoose from 'mongoose'

import { hashPassword } from '../auth/passwords.js'
import { loadConfig } from '../config.js'
import { createMongooseRepositories } from '../repositories/mongooseRepositories.js'

const MIN_PASSWORD_LENGTH = 8
const DEFAULT_COMMUNITY_NAME = 'Default Community'
const DEFAULT_ROOT_NAME = 'Root'
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * @param {Record<string, string|undefined>} [env]
 * @throws {Error} when a required value is missing or malformed
 */
export function readSeedInput(env = process.env) {
  const missing = []

  const rootEmail = (env.SEED_ROOT_EMAIL ?? '').trim().toLowerCase()
  const rootPassword = env.SEED_ROOT_PASSWORD ?? ''

  if (rootEmail === '') missing.push('SEED_ROOT_EMAIL')
  if (rootPassword === '') missing.push('SEED_ROOT_PASSWORD')

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. See server/.env.example.`,
    )
  }

  if (!EMAIL_PATTERN.test(rootEmail)) {
    throw new Error('SEED_ROOT_EMAIL must be a valid email address.')
  }
  if (rootPassword.length < MIN_PASSWORD_LENGTH) {
    // Names the variable, never the value — error output gets pasted into chats.
    throw new Error(`SEED_ROOT_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  }

  return {
    rootEmail,
    rootPassword,
    rootName: (env.SEED_ROOT_NAME ?? '').trim() || DEFAULT_ROOT_NAME,
    communityName: (env.SEED_COMMUNITY_NAME ?? '').trim() || DEFAULT_COMMUNITY_NAME,
  }
}

/**
 * @param {{repositories: object, input: ReturnType<typeof readSeedInput>}} params
 * @returns {Promise<{userId: string, communityId: string, created: {user: boolean, community: boolean, membership: boolean}}>}
 */
export async function seed({ repositories, input }) {
  const created = { user: false, community: false, membership: false }

  let user = await repositories.users.findByEmail(input.rootEmail)
  if (!user) {
    user = await repositories.users.create({
      email: input.rootEmail,
      name: input.rootName,
      passwordHash: await hashPassword(input.rootPassword),
      // The root chose this password deliberately, so there is nothing to force a change from.
      mustChangePassword: false,
    })
    created.user = true
  }

  const memberships = await repositories.memberships.listByUser(user.id)
  if (memberships.length > 0) {
    // Already seeded. Re-running is a no-op rather than an error.
    return { userId: user.id, communityId: memberships[0].communityId, created }
  }

  const community = await repositories.communities.create({
    name: input.communityName,
    createdBy: user.id,
  })
  await repositories.memberships.create({
    userId: user.id,
    communityId: community.id,
    role: 'root',
  })
  created.community = true
  created.membership = true

  return { userId: user.id, communityId: community.id, created }
}

async function main() {
  const config = loadConfig()
  const input = readSeedInput()

  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 10000 })

  try {
    const result = await seed({ repositories: createMongooseRepositories(), input })

    if (!result.created.user && !result.created.community) {
      console.log(`Already seeded: ${input.rootEmail} is already a member of a community.`)
    } else {
      console.log('Seed complete:')
      console.log(`  root email   : ${input.rootEmail}`)
      console.log(`  community    : ${input.communityName}`)
      console.log(`  user created : ${result.created.user}`)
      console.log(`  community id : ${result.communityId}`)
    }
  } finally {
    await mongoose.disconnect()
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`Seed failed: ${error.message}`)
    process.exitCode = 1
  })
}
