import { describe, it, expect } from 'vitest'
import mongoose from 'mongoose'

import { User, Community, Membership, Event, Zone, Group, Assignment } from '../../src/models/index.js'
import { ROLES } from '../../src/domain/permissions.js'

// Schema validation for the persistence layer.
//
// These run without a database on purpose: Mongoose validates a document in memory, so the
// rules that protect data integrity can be proven with no Atlas cluster, no network, and no
// container. Query behaviour still needs a real MongoDB, but the invariants below are exactly
// the ones that are expensive to discover in production.
//
// Reference fields use real ObjectIds. Using short strings like 'e1' would make every negative
// assertion pass on a CastError rather than the rule under test — the test would look green
// while proving nothing.

const oid = () => new mongoose.Types.ObjectId()

describe('User', () => {
  it('requires an email and a password hash', () => {
    const errors = new User({}).validateSync()?.errors

    expect(errors?.email).toBeDefined()
    expect(errors?.passwordHash).toBeDefined()
  })

  it('normalises the email so lookups cannot miss on case', () => {
    const user = new User({ email: '  Admin@Example.COM  ', passwordHash: 'hash' })

    expect(user.email).toBe('admin@example.com')
  })

  it('rejects a malformed email', () => {
    const errors = new User({ email: 'not-an-email', passwordHash: 'hash' }).validateSync()?.errors

    expect(errors?.email).toBeDefined()
  })

  it('defaults mustChangePassword to true, because accounts are admin-provisioned', () => {
    // A new account holds a temporary password until its owner changes it (spec 5.1).
    expect(new User({ email: 'a@b.com', passwordHash: 'hash' }).mustChangePassword).toBe(true)
  })
})

describe('Community', () => {
  it('requires a name', () => {
    expect(new Community({}).validateSync()?.errors?.name).toBeDefined()
  })
})

describe('Membership', () => {
  const valid = () => ({ userId: oid(), communityId: oid(), role: 'planner' })

  it('requires a user, a community and a role', () => {
    const errors = new Membership({}).validateSync()?.errors

    expect(errors?.userId).toBeDefined()
    expect(errors?.communityId).toBeDefined()
    expect(errors?.role).toBeDefined()
  })

  it('rejects a role the RBAC matrix does not know', () => {
    const errors = new Membership({ ...valid(), role: 'wizard' }).validateSync()?.errors

    expect(errors?.role).toBeDefined()
  })

  it('accepts every role the RBAC matrix defines', () => {
    // Ties the database enum to the permission matrix, so adding a role in one place and
    // forgetting the other fails here rather than in production.
    for (const role of ROLES) {
      const errors = new Membership({ ...valid(), role }).validateSync()?.errors
      expect(errors?.role).toBeUndefined()
    }
  })
})

describe('Event', () => {
  const base = () => ({ communityId: oid(), name: 'Parade' })

  it('requires a name', () => {
    expect(new Event({ communityId: oid() }).validateSync()?.errors?.name).toBeDefined()
  })

  it('defaults to a plan layout and a draft status', () => {
    const event = new Event(base())

    expect(event.layoutMode).toBe('plan')
    expect(event.status).toBe('draft')
  })

  it('rejects a layout mode the conflict engine cannot handle', () => {
    const errors = new Event({ ...base(), layoutMode: 'hologram' }).validateSync()?.errors

    expect(errors?.layoutMode).toBeDefined()
  })

  it('accepts exactly the lifecycle states the spec defines', () => {
    for (const status of ['draft', 'live', 'ended']) {
      expect(new Event({ ...base(), status }).validateSync()?.errors?.status).toBeUndefined()
    }
    expect(new Event({ ...base(), status: 'paused' }).validateSync()?.errors?.status).toBeDefined()
  })
})

describe('Zone', () => {
  const triangle = [[1.32, 103.84], [1.31, 103.84], [1.31, 103.83]]
  const base = () => ({ eventId: oid(), name: 'Main Stage' })

  it('rejects a polygon with fewer than three points', () => {
    const errors = new Zone({ ...base(), polygon: [[1.32, 103.84], [1.31, 103.84]] }).validateSync()?.errors

    expect(errors?.polygon).toBeDefined()
  })

  it('rejects a polygon whose points are not coordinate pairs', () => {
    const errors = new Zone({ ...base(), polygon: [[1.32, 103.84], 'x', [1.31, 103.83]] }).validateSync()?.errors

    expect(errors?.polygon).toBeDefined()
  })

  it('rejects a polygon whose coordinates are not numbers', () => {
    const errors = new Zone({ ...base(), polygon: [['a', 'b'], [1, 2], [3, 4]] }).validateSync()?.errors

    expect(errors?.polygon).toBeDefined()
  })

  it('accepts a valid polygon', () => {
    expect(new Zone({ ...base(), polygon: triangle }).validateSync()?.errors?.polygon).toBeUndefined()
  })

  it('defaults to a normal zone and rejects an unknown kind', () => {
    expect(new Zone({ ...base(), polygon: triangle }).kind).toBe('zone')
    const errors = new Zone({ ...base(), polygon: triangle, kind: 'swimming-pool' }).validateSync()?.errors
    expect(errors?.kind).toBeDefined()
  })

  it('accepts the shape kinds the layout designer can place', () => {
    for (const kind of ['zone', 'blocked', 'obstacle', 'stairs', 'lift']) {
      expect(new Zone({ ...base(), polygon: triangle, kind }).validateSync()?.errors?.kind).toBeUndefined()
    }
  })
})

describe('Group', () => {
  it('requires an event and a name', () => {
    const errors = new Group({}).validateSync()?.errors

    expect(errors?.eventId).toBeDefined()
    expect(errors?.name).toBeDefined()
  })

  it('accepts an event and a name', () => {
    expect(new Group({ eventId: oid(), name: 'Group A' }).validateSync()).toBeUndefined()
  })
})

describe('Assignment', () => {
  const base = () => ({
    eventId: oid(),
    groupId: oid(),
    zoneId: oid(),
    start: new Date('2026-03-01T09:00:00+08:00'),
    end: new Date('2026-03-01T09:30:00+08:00'),
  })

  it('requires the event, group, zone and a time window', () => {
    const errors = new Assignment({}).validateSync()?.errors

    expect(errors?.eventId).toBeDefined()
    expect(errors?.groupId).toBeDefined()
    expect(errors?.zoneId).toBeDefined()
    expect(errors?.start).toBeDefined()
    expect(errors?.end).toBeDefined()
  })

  it('accepts a window that ends after it starts', () => {
    expect(new Assignment(base()).validateSync()?.errors?.end).toBeUndefined()
  })

  it('rejects a window that ends before it starts', () => {
    const errors = new Assignment({
      ...base(),
      start: new Date('2026-03-01T10:00:00+08:00'),
      end: new Date('2026-03-01T09:00:00+08:00'),
    }).validateSync()?.errors

    expect(errors?.end).toBeDefined()
  })

  it('rejects a zero-length window', () => {
    const at = new Date('2026-03-01T09:00:00+08:00')
    const errors = new Assignment({ ...base(), start: at, end: at }).validateSync()?.errors

    expect(errors?.end).toBeDefined()
  })
})
