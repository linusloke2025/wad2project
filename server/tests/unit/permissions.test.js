import { describe, it, expect } from 'vitest'

// Namespace import so missing exports fail as behaviour, not as an ESM link error.
import * as permissions from '../../src/domain/permissions.js'

// Acceptance criteria 1 and 3.
//
// The permission matrix from docs/SPEC.md section 4. Roles are per-community memberships, so
// `can()` takes an actor and a capability and answers a pure question; the middleware that
// turns a denial into HTTP 403 is a separate, thinner concern.
//
// The load-bearing rule is the privilege-escalation boundary: an admin may manage ordinary
// users but must NOT be able to touch another admin, or root, or grant admin itself. That is
// the single most likely thing an examiner will probe at Q&A.

const { can } = permissions

describe('can — role capabilities', () => {
  it('allows root every capability', () => {
    for (const capability of permissions.ALL_CAPABILITIES) {
      expect(can({ role: 'root' }, capability)).toBe(true)
    }
  })

  it('allows an admin to manage an ordinary user', () => {
    expect(can({ role: 'admin' }, 'user.manage', { targetRole: 'user' })).toBe(true)
    expect(can({ role: 'admin' }, 'user.massAdd')).toBe(true)
  })

  it('forbids an admin from managing another admin', () => {
    expect(can({ role: 'admin' }, 'user.manage', { targetRole: 'admin' })).toBe(false)
  })

  it('forbids an admin from managing root', () => {
    expect(can({ role: 'admin' }, 'user.manage', { targetRole: 'root' })).toBe(false)
  })

  it('forbids an admin from adding or removing admins', () => {
    expect(can({ role: 'admin' }, 'admin.manage')).toBe(false)
    expect(can({ role: 'admin' }, 'admin.manage', { targetRole: 'user' })).toBe(false)
  })

  it('forbids an admin from managing community settings', () => {
    expect(can({ role: 'admin' }, 'community.settings')).toBe(false)
  })

  it('lets root manage admins', () => {
    expect(can({ role: 'root' }, 'admin.manage')).toBe(true)
    expect(can({ role: 'root' }, 'user.manage', { targetRole: 'admin' })).toBe(true)
  })
})

describe('can — event authority', () => {
  it('lets a planner edit an event but not create or delete one', () => {
    expect(can({ role: 'planner' }, 'event.edit')).toBe(true)
    expect(can({ role: 'planner' }, 'event.create')).toBe(false)
    expect(can({ role: 'planner' }, 'event.delete')).toBe(false)
  })

  it('lets an admin create and delete events', () => {
    expect(can({ role: 'admin' }, 'event.create')).toBe(true)
    expect(can({ role: 'admin' }, 'event.delete')).toBe(true)
  })

  it('lets a planner control the live event', () => {
    expect(can({ role: 'planner' }, 'event.control')).toBe(true)
  })
})

describe('can — layout designer scope', () => {
  it('lets a designer manage the layout', () => {
    expect(can({ role: 'layout_designer' }, 'layout.manage')).toBe(true)
  })

  it('does not let a designer manage users, groups, or events', () => {
    expect(can({ role: 'layout_designer' }, 'user.manage')).toBe(false)
    expect(can({ role: 'layout_designer' }, 'group.manage')).toBe(false)
    expect(can({ role: 'layout_designer' }, 'event.create')).toBe(false)
  })

  it('lets a designer view conflicts, since they cause some of them', () => {
    expect(can({ role: 'layout_designer' }, 'conflict.view')).toBe(true)
  })
})

describe('can — ordinary user is tightly scoped', () => {
  it('denies a user planning and administrative capabilities', () => {
    expect(can({ role: 'user' }, 'conflict.view')).toBe(false)
    expect(can({ role: 'user' }, 'event.create')).toBe(false)
    expect(can({ role: 'user' }, 'group.manage')).toBe(false)
    expect(can({ role: 'user' }, 'report.view')).toBe(false)
    expect(can({ role: 'user' }, 'layout.manage')).toBe(false)
  })

  it('lets a user report status only when they lead the group', () => {
    expect(can({ role: 'user' }, 'status.report', { isGroupLead: true })).toBe(true)
    expect(can({ role: 'user' }, 'status.report', { isGroupLead: false })).toBe(false)
    expect(can({ role: 'user' }, 'status.report', {})).toBe(false)
  })

  it('lets a user see the live board', () => {
    expect(can({ role: 'user' }, 'live.view')).toBe(true)
  })

  it('lets a planner report status without being a group lead', () => {
    expect(can({ role: 'planner' }, 'status.report')).toBe(true)
  })
})

describe('can — fails closed', () => {
  it('denies every capability for an unknown role', () => {
    for (const capability of permissions.ALL_CAPABILITIES) {
      expect(can({ role: 'wizard' }, capability)).toBe(false)
    }
  })

  it('denies every capability for a missing or malformed actor', () => {
    for (const capability of permissions.ALL_CAPABILITIES) {
      expect(can(undefined, capability)).toBe(false)
      expect(can({}, capability)).toBe(false)
    }
  })

  it('denies an unknown capability for root', () => {
    expect(can({ role: 'root' }, 'nonsense.capability')).toBe(false)
  })
})
