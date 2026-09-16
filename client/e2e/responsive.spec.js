import { test, expect } from '@playwright/test'

import { E2E_USERS } from '../../server/src/scripts/e2eFixtures.js'
import { horizontalOverflow, signIn } from './helpers.js'

/**
 * Responsive behaviour, run at the three widths the brief names.
 *
 * The brief says the app is tested "using Chrome's developer tools across various viewports,
 * starting from the iPhone 6 to the XL breakpoint of Bootstrap". So the projects in
 * playwright.config.js pin exactly those: 375px, 768px and 1200px.
 *
 * Horizontal overflow is the assertion because it is objective and is the failure that actually
 * hurts on a phone — content sliding sideways under the thumb. A screenshot comparison would be
 * prettier to look at and far more brittle for no extra signal.
 */

test.describe('Responsive behaviour', () => {
  test('the sign-in page fits the viewport', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByTestId('sign-in')).toBeVisible()

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  })

  test('the events list fits the viewport', async ({ page }) => {
    await signIn(page, E2E_USERS.root)
    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible()

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  })

  test('the event plan fits the viewport', async ({ page }) => {
    await signIn(page, E2E_USERS.root)
    await page.getByRole('link', { name: 'Open plan' }).first().click()
    await expect(page.getByTestId('event-name')).toBeVisible()

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  })

  test('the primary actions stay tappable at mobile sizes', async ({ page }) => {
    await signIn(page, E2E_USERS.root)

    const box = await page.getByTestId('new-event').boundingBox()

    // Only meaningful below the md breakpoint, where the app.css rule applies.
    const isMobileWidth = page.viewportSize().width < 768
    if (isMobileWidth) {
      expect(box.height).toBeGreaterThanOrEqual(44)
    } else {
      expect(box.height).toBeGreaterThan(0)
    }
  })
})
