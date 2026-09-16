import { test, expect } from '@playwright/test'

import { E2E_USERS } from '../../server/src/scripts/e2eFixtures.js'
import { openSeededEvent, signIn } from './helpers.js'

/**
 * Journey 6 — live tracking.
 *
 * The claim being tested is that a planner learns where a group is without asking, so the
 * central case uses two independent browser sessions: one reporting, one watching. A single-page
 * test could pass while nothing was ever delivered to anyone else.
 *
 * Declaration order matters here. These share one event and mutate its live state, so the
 * "nothing reported yet" case is first. Fixtures are reset before the run, but not between tests.
 */

async function openBoard(context, email, eventName = 'E2E Parade') {
  const page = await context.newPage()
  await signIn(page, email)
  await openSeededEvent(page, eventName)
  await expect(page.getByTestId('live-connection')).toBeVisible()
  return page
}

test.describe('Journey 6 — live tracking', () => {
  test('a planner sees every group, including the ones that have not reported', async ({ page }) => {
    await signIn(page, E2E_USERS.planner)
    await openSeededEvent(page, 'E2E Parade')

    // Scoped to the seeded groups rather than counted: other journeys in the same run create
    // their own groups on this shared event, so a total would depend on execution order.
    // The assertion that matters is that a group with nothing to say is still listed — a board
    // showing only the groups that have reported would hide exactly the silence worth noticing.
    await expect(page.locator('[data-group-name="Group A"] [data-testid="live-status"]')).toHaveText('No report')
    await expect(page.locator('[data-group-name="Group B"] [data-testid="live-status"]')).toHaveText('No report')
  })

  test('a group lead status report reaches a planner in a separate session', async ({ browser }) => {
    const leadContext = await browser.newContext()
    const plannerContext = await browser.newContext()

    const leadPage = await openBoard(leadContext, E2E_USERS.lead)
    // The lead leads Group A only, so their board is scoped to it — whatever else exists.
    await expect(leadPage.getByTestId('live-group')).toHaveCount(1)

    const plannerPage = await openBoard(plannerContext, E2E_USERS.planner)
    await expect(plannerPage.locator('[data-group-name="Group A"] [data-testid="live-status"]')).toHaveText(
      'No report',
    )

    // The lead does not touch the planner's page. If the update appears there, it was pushed.
    await leadPage.getByTestId('report-moving').click()

    await expect(plannerPage.locator('[data-group-name="Group A"] [data-testid="live-status"]')).toHaveText(
      'Moving',
    )

    await leadContext.close()
    await plannerContext.close()
  })

  test('a lead shares a device position and the planner sees the coordinates', async ({ browser }) => {
    // Geolocation is emulated rather than requested from the machine: Playwright can grant the
    // permission and supply fixed coordinates, so the GPS path is testable without a real fix.
    const leadContext = await browser.newContext({
      permissions: ['geolocation'],
      geolocation: { latitude: 1.31955, longitude: 103.84223 },
    })
    const plannerContext = await browser.newContext()

    const leadPage = await openBoard(leadContext, E2E_USERS.lead)
    const plannerPage = await openBoard(plannerContext, E2E_USERS.planner)

    await leadPage.getByTestId('share-position').click()

    await expect(plannerPage.getByTestId('live-position')).toContainText('1.31955')

    await leadContext.close()
    await plannerContext.close()
  })

  test('a lead answers an announcement with a fixed signal and the tally reflects it', async ({ browser }) => {
    const plannerContext = await browser.newContext()
    const leadContext = await browser.newContext()

    const plannerPage = await openBoard(plannerContext, E2E_USERS.planner)
    await plannerPage.getByTestId('broadcast-input').fill('Group A hold at the holding area')
    await plannerPage.getByTestId('broadcast-send').click()
    await expect(plannerPage.getByTestId('live-announcements')).toContainText('hold at the holding area')

    const leadPage = await openBoard(leadContext, E2E_USERS.lead)
    await expect(leadPage.getByTestId('live-announcements')).toContainText('hold at the holding area')

    await leadPage.getByTestId('respond-acknowledged').click()

    // The lead leads one group, so their answer is unambiguous and exactly one acknowledgement is
    // recorded. The denominator is deliberately not asserted: other journeys in the same run add
    // groups to this shared event, so it depends on execution order while the numerator does not.
    await expect(leadPage.getByTestId('live-ack-tally').first()).toContainText(/^1 of \d+ acknowledged/)

    await plannerContext.close()
    await leadContext.close()
  })

  test('the announcement composer is offered only to roles that may broadcast', async ({ browser }) => {
    const memberContext = await browser.newContext()
    const adminContext = await browser.newContext()

    const memberPage = await openBoard(memberContext, E2E_USERS.member)
    await expect(memberPage.getByTestId('broadcast-input')).toHaveCount(0)

    const adminPage = await openBoard(adminContext, E2E_USERS.admin)
    await expect(adminPage.getByTestId('broadcast-input')).toBeVisible()

    await memberContext.close()
    await adminContext.close()
  })
})
