/**
 * Role-based access control, derived from the permission matrix in docs/SPEC.md section 4.
 *
 * Roles are per-community memberships, so this module answers a pure question — "may this actor
 * do this?" — and knows nothing about HTTP, Mongoose, or communities. The middleware that turns
 * a denial into a 403 is a separate, thinner concern.
 *
 * Two things make this more than a lookup table:
 *
 * 1. The privilege-escalation guard. An admin may manage ordinary users but must not be able to
 *    touch another admin, touch root, or grant admin. A flat role -> capability map cannot
 *    express that, because the answer depends on the *target* as well as the actor.
 *
 * 2. Fail-closed defaults. An unknown role, a malformed actor, or an unknown capability all
 *    deny. A permission bug must never open access.
 */

export const ROLES = ['root', 'admin', 'layout_designer', 'planner', 'user']

export const ALL_CAPABILITIES = [
  'community.settings',
  'admin.manage',
  'user.manage',
  'user.massAdd',
  'event.create',
  'event.delete',
  'event.edit',
  'event.control',
  'layout.manage',
  'group.manage',
  'conflict.view',
  'live.view',
  'status.report',
  'report.view',
]

/**
 * Which roles hold each capability outright, before target-aware guards.
 *
 * Deliberately excludes planner from event.create / event.delete: a planner coordinates an
 * event but must not be able to destroy one.
 */
const GRANTS = {
  'community.settings': ['root'],
  'admin.manage': ['root'],
  'user.manage': ['root', 'admin'],
  'user.massAdd': ['root', 'admin'],
  'event.create': ['root', 'admin'],
  'event.delete': ['root', 'admin'],
  'event.edit': ['root', 'admin', 'planner'],
  'event.control': ['root', 'admin', 'planner'],
  'layout.manage': ['root', 'admin', 'layout_designer'],
  'group.manage': ['root', 'admin', 'planner'],
  'conflict.view': ['root', 'admin', 'layout_designer', 'planner'],
  'live.view': ['root', 'admin', 'layout_designer', 'planner', 'user'],
  'status.report': ['root', 'admin', 'layout_designer', 'planner', 'user'],
  'report.view': ['root', 'admin', 'layout_designer', 'planner'],
}

/**
 * @param {{role?: string, id?: string}|undefined} actor
 * @param {string} capability
 * @param {{targetRole?: string, isGroupLead?: boolean, groupId?: string}} [context]
 * @returns {boolean}
 */
export function can(actor, capability, context = {}) {
  if (!actor || typeof actor !== 'object') return false

  const granted = GRANTS[capability]
  if (!granted) return false
  if (!granted.includes(actor.role)) return false

  // Privilege-escalation guard: admins may not act on admins or on root.
  if (capability === 'user.manage' && actor.role === 'admin') {
    const target = context.targetRole
    if (target === 'admin' || target === 'root') return false
  }

  // Reporting is the one capability an ordinary user can hold, and only for a group they lead.
  if (capability === 'status.report' && actor.role === 'user') {
    return context.isGroupLead === true
  }

  return true
}

/** Roles that hold a capability outright. Useful for building admin UIs. */
export function rolesFor(capability) {
  return [...(GRANTS[capability] ?? [])]
}
