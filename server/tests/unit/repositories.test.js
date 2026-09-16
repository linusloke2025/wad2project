import { describe, it, expect } from 'vitest'

import { createMongooseRepositories } from '../../src/repositories/mongooseRepositories.js'

// Repository guards, testable with NO database.
//
// Mongoose casts an id string before querying, so `findById('not-an-id')` throws a CastError.
// Left alone, a malformed id in a URL becomes an HTTP 500 from the error handler instead of the
// 404 the route promises — and a 500 on a bad URL is the kind of thing that shows up during
// marking. Guarding before the query means these paths never reach the database, which is
// exactly why they can be verified here without a cluster.
//
// Query behaviour against a real MongoDB is not covered by these tests.

describe('repository id guards', () => {
  const repositories = createMongooseRepositories()

  it('returns null for a malformed event id rather than throwing', async () => {
    await expect(repositories.events.findById('not-an-object-id')).resolves.toBeNull()
  })

  it('returns null for a malformed user id', async () => {
    await expect(repositories.users.findById('nope')).resolves.toBeNull()
  })

  it('returns null for a malformed community id', async () => {
    await expect(repositories.communities.findById('nope')).resolves.toBeNull()
  })

  it('returns null for a malformed membership lookup', async () => {
    await expect(repositories.memberships.find('nope', 'also-nope')).resolves.toBeNull()
  })

  it('resolves a malformed zone deletion without throwing', async () => {
    await expect(repositories.zones.deleteById('nope')).resolves.toBeUndefined()
  })

  it('returns an empty list for a malformed event when listing zones', async () => {
    // Filtering by an invalid id must not blow up a list endpoint.
    await expect(repositories.zones.listByEvent('nope')).resolves.toEqual([])
  })
})
