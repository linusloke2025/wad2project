/**
 * End-to-end fixture constants.
 *
 * Kept in a module with no imports so the Playwright specs can share the credentials without
 * loading mongoose into the test process. Duplicating them in the specs instead would let the
 * two drift, and a drifted credential fails as a confusing sign-in error rather than as a test
 * setup problem.
 */

export const E2E_COMMUNITY_NAME = 'E2E Community'
export const E2E_PASSWORD = 'E2ePassword123'
export const E2E_EVENT_NAME = 'E2E Parade'
export const E2E_ZONE_NAMES = ['Main Stage', 'Holding Area']

/**
 * persona -> email.
 *
 * A persona is not a role: `lead` and `member` are both ordinary users, distinguished only by
 * whether they lead a group. Keying this map by role produced an invalid enum value the first
 * time it ran, because `designer` and `lead` are not roles the schema accepts. The two concepts
 * are therefore kept separate, and E2E_ROLES below is the mapping that actually reaches the
 * database.
 */
export const E2E_USERS = {
  root: 'e2e-root@example.com',
  admin: 'e2e-admin@example.com',
  planner: 'e2e-planner@example.com',
  designer: 'e2e-designer@example.com',
  lead: 'e2e-lead@example.com',
  member: 'e2e-member@example.com',
  // The only account left on a temporary password, so the forced-change journey has something
  // to exercise while every other persona can sign in and go straight to work.
  temp: 'e2e-temp@example.com',
}

/** persona -> the role stored in the membership. Values must exist in the RBAC matrix. */
export const E2E_ROLES = {
  root: 'root',
  admin: 'admin',
  planner: 'planner',
  designer: 'layout_designer',
  lead: 'user',
  member: 'user',
  temp: 'user',
}

export const E2E_TEMP_ACCOUNT = E2E_USERS.temp
export const E2E_TEMP_PASSWORD = 'E2eTempPass123'
