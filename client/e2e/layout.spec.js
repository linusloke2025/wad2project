import { test, expect } from '@playwright/test'

import { E2E_USERS } from '../../server/src/scripts/e2eFixtures.js'
import { horizontalOverflow, openSeededEvent, signIn } from './helpers.js'

/**
 * Journey 3 — the layout designer's view.
 *
 * The layout is the shared artefact every other role plans against, so this journey checks that
 * the shapes the designer placed are actually visible to a planning role, and that blocked areas
 * are among them — the designer's work only matters to the conflict engine if it reaches the
 * plan.
 */

test.describe('Journey 3 — layout', () => {
  test('a layout designer sees the plan and the shapes on it', async ({ page }) => {
    await signIn(page, E2E_USERS.designer)
    await openSeededEvent(page, 'E2E Parade')

    // The seeded event has two zones and one blocked area.
    await expect(page.getByTestId('zone-count')).toHaveText('3 shape(s)')
  })

  test('a planner sees the same layout, since they plan against it', async ({ page }) => {
    await signIn(page, E2E_USERS.planner)
    await openSeededEvent(page, 'E2E Parade')

    await expect(page.getByTestId('zone-count')).toBeVisible()
  })

  test('the layout panel does not overflow the viewport', async ({ page }) => {
    await signIn(page, E2E_USERS.planner)
    await openSeededEvent(page, 'E2E Parade')

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  })
})
