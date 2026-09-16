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

  test('a planner staffs a group and designates its lead', async ({ page }) => {
    // A group with no lead can never report a status, so this is what makes a group operative
    // rather than merely listed.
    await signIn(page, E2E_USERS.planner)
    await openSeededEvent(page, 'E2E Parade')

    const name = uniqueName('Staffed Group')
    await addGroup(page, name)

    // Scoped to the row, because every group shares the same set of controls.
    const row = page.locator(`li[data-group-name="${name}"]`)
    await expect(row.getByTestId('manage-group')).toContainText('Members (0)')

    await row.getByTestId('manage-group').click()
    await row.getByTestId('member-checkbox').first().check()
    // Index 0 is "No lead"; index 1 is the member just ticked.
    await row.getByTestId('lead-select').selectOption({ index: 1 })
    await row.getByTestId('save-members').click()

    await expect(row.getByTestId('lead-badge')).toBeVisible()
    await expect(row.getByTestId('manage-group')).toContainText('Members (1)')
  })
})
