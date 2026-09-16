import { test, expect } from '@playwright/test'

import { E2E_USERS } from '../../server/src/scripts/e2eFixtures.js'
import { addGroup, expectGroupListed, openSeededEvent, signIn, uniqueName } from './helpers.js'

/**
 * Journey 4 — planning groups and movements.
 *
 * Groups are created with unique names so repeated runs do not collide: the fixture event is
 * shared across journeys, and a fixed name would make the second run fail on a duplicate rather
 * than on a real defect.
 */

test.describe('Journey 4 — scheduling', () => {
  test('a planner adds a group and it appears unscheduled', async ({ page }) => {
    await signIn(page, E2E_USERS.planner)
    await openSeededEvent(page, 'E2E Parade')

    const name = uniqueName('Journey Group')
    await addGroup(page, name)

    await expectGroupListed(page, name)
    // A group with no slot is exactly the gap the app exists to surface.
    await expect(page.getByTestId('group-unscheduled').first()).toBeVisible()
  })

  test('a planner schedules a group into a zone and the slot is listed', async ({ page }) => {
    await signIn(page, E2E_USERS.planner)
    await openSeededEvent(page, 'E2E Parade')

    const name = uniqueName('Scheduled Group')
    await addGroup(page, name)

    await page.getByTestId('assign-group').selectOption({ label: name })
    // Holding Area, not Main Stage: Main Stage overlaps the blocked area, which would add an
    // unrelated conflict and make this assertion about the wrong thing.
    await page.getByTestId('assign-zone').selectOption({ label: 'Holding Area' })
    await page.getByTestId('assign-start').fill('2026-03-01T09:00')
    await page.getByTestId('assign-end').fill('2026-03-01T09:30')
    await page.getByTestId('add-assignment').click()

    await expect(page.getByTestId('assignment-slot').first()).toContainText('Holding Area')
  })

  test('the schedule form refuses an incomplete submission', async ({ page }) => {
    await signIn(page, E2E_USERS.planner)
    await openSeededEvent(page, 'E2E Parade')

    // Nothing chosen, so the app must explain rather than post an empty slot.
    await page.getByTestId('add-assignment').click()

    await expect(page.getByTestId('schedule-error')).toContainText('Choose a group')
  })
})
