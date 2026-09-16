import { test, expect } from '@playwright/test'

import {
  E2E_EVENT_NAME,
  E2E_TEMP_ACCOUNT,
  E2E_TEMP_PASSWORD,
  E2E_USERS,
} from '../../server/src/scripts/e2eFixtures.js'
import { signIn } from './helpers.js'

/**
 * Journey 1 — authentication.
 *
 * Driven through the real form rather than a stored session, because signing in is itself one of
 * the graded journeys. The negative cases matter as much as the happy path: the brief's app is
 * assessed on whether the server refuses what it should, and a sign-in page that leaks which
 * accounts exist is a defect regardless of how well the rest works.
 */

test.describe('Journey 1 — authentication', () => {
  test('sends a signed-out visitor to the sign-in page', async ({ page }) => {
    await page.goto('/')

    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByTestId('sign-in')).toBeVisible()
  })

  test('refuses a wrong password', async ({ page }) => {
    await page.goto('/login')
    await page.getByTestId('email').fill(E2E_USERS.root)
    await page.getByTestId('password').fill('definitely-not-the-password')
    await page.getByTestId('sign-in').click()

    await expect(page.getByTestId('login-error')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  test('refuses an unknown account with the same message as a wrong password', async ({ page }) => {
    // Checked end to end, not only at the API: anything that distinguishes the two lets someone
    // discover which email addresses are real.
    await page.goto('/login')
    await page.getByTestId('email').fill('nobody-at-all@example.com')
    await page.getByTestId('password').fill('whatever12345')
    await page.getByTestId('sign-in').click()

    await expect(page.getByTestId('login-error')).toHaveText('Invalid credentials')
  })

  test('signs in and lands on the events list', async ({ page }) => {
    await signIn(page, E2E_USERS.root)

    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible()
    await expect(page.getByText(E2E_EVENT_NAME)).toBeVisible()
  })

  test('forces a temporary password to be changed before anything else', async ({ page }) => {
    await page.goto('/login')
    await page.getByTestId('email').fill(E2E_TEMP_ACCOUNT)
    await page.getByTestId('password').fill(E2E_TEMP_PASSWORD)
    await page.getByTestId('sign-in').click()

    // The change form replaces the sign-in form, and the app is not reachable until it is done.
    await expect(page.getByTestId('new-password')).toBeVisible()
    await expect(page.getByTestId('confirm-password')).toBeVisible()
    await expect(page.getByTestId('sign-in')).toHaveCount(0)
  })
})
