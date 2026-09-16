import { test, expect } from '@playwright/test'

import { E2E_USERS } from '../../server/src/scripts/e2eFixtures.js'
import { openSeededEvent, signIn } from './helpers.js'

/**
 * Journey 2 — role-based access.
 *
 * The point is that the UI shows each role only what it may do, and that the split is visible
 * rather than implied. The server refuses regardless — that is proven by the HTTP tests — so
 * these check the other half: that a planner is not offered a button that would 403, and that a
 * member on the ground is not shown the whole plan.
 */

test.describe('Journey 2 — role-based access', () => {
  test('a planner is not offered the create-event control', async ({ page }) => {
    await signIn(page, E2E_USERS.planner)
    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible()

    // Present in the DOM only for root and admin: a planner coordinates an event but must not
    // be able to create or destroy one.
    await expect(page.getByTestId('new-event')).toHaveCount(0)
  })

  test('an admin is offered the create-event control', async ({ page }) => {
    await signIn(page, E2E_USERS.admin)

    await expect(page.getByTestId('new-event')).toBeVisible()
  })

  test('a layout designer sees the plan but no schedule controls', async ({ page }) => {
    await signIn(page, E2E_USERS.designer)
    await openSeededEvent(page, 'E2E Parade')

    // The designer causes some conflicts, so they may see them…
    await expect(page.getByTestId('conflict-count')).toBeVisible()
    // …but scheduling movements is the planner's job, not theirs.
    await expect(page.getByTestId('add-group')).toHaveCount(0)
  })

  test('an ordinary member is not shown the plan at all', async ({ page }) => {
    await signIn(page, E2E_USERS.member)
    await openSeededEvent(page, 'E2E Parade')

    // They reached the event — they need to know it exists — but the planning panels,
    // including group composition and the conflict list, are not theirs to see.
    await expect(page.getByTestId('conflict-count')).toHaveCount(0)
    await expect(page.getByTestId('group-list')).toHaveCount(0)
    await expect(page.getByTestId('announcement-list')).toHaveCount(0)
  })
})
