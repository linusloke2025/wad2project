import { describe, it, expect } from 'vitest'

import { assertE2eDatabase } from '../../src/scripts/seedE2E.js'

// The guard that stops end-to-end fixtures landing in the application database.
//
// DISCLOSURE: this guard was written as part of the E2E scaffolding before this test existed, so
// this run is a regression guard rather than red-first evidence. The ordering is worth stating
// rather than glossing over — the assertion below is what stops it being quietly removed later.
//
// The trap it exists for: the E2E run starts from the same MONGODB_URI the app uses. A config
// typo would otherwise create test accounts and events in the real data, which is both hard to
// notice and awkward to undo.

describe('assertE2eDatabase', () => {
  it('accepts a database whose name ends in -e2e', () => {
    expect(() => assertE2eDatabase('mongodb+srv://u:p@cluster0.example.net/wad2-e2e?retryWrites=true')).not.toThrow()
  })

  it('refuses the application database', () => {
    expect(() => assertE2eDatabase('mongodb+srv://u:p@cluster0.example.net/wad2?retryWrites=true')).toThrow(/wad2/)
  })

  it('is not fooled by a host that merely contains "e2e"', () => {
    // The whole reason the check reads the path segment rather than the string: a hostname like
    // cluster0-e2e.example.net says nothing about which database is being written to.
    expect(() => assertE2eDatabase('mongodb+srv://u:p@cluster0-e2e.example.net/wad2?socketTimeoutMS=1')).toThrow(
      /-e2e/,
    )
  })

  it('refuses a URI with no database name at all', () => {
    // A missing database name makes the driver default to "test", which is nobody's intention.
    expect(() => assertE2eDatabase('mongodb+srv://u:p@cluster0.example.net/?retryWrites=true')).toThrow()
  })

  it('can be forced, for a deliberate one-off', () => {
    expect(() => assertE2eDatabase('mongodb+srv://u:p@c.example.net/wad2', { force: true })).not.toThrow()
  })
})
