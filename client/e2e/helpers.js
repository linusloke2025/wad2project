import { expect } from '@playwright/test'

import { E2E_PASSWORD } from '../../server/src/scripts/e2eFixtures.js'

/**
 * Sign in through the real form.
 *
 * Deliberately not a storage-state shortcut: the sign-in path is one of the journeys being
 * graded, so every spec that needs a session also exercises it.
 */
export async function signIn(page, email, password = E2E_PASSWORD) {
  await page.goto('/login')
  await page.getByTestId('email').fill(email)
  await page.getByTestId('password').fill(password)
  await page.getByTestId('sign-in').click()

  // Wait for the redirect rather than a fixed timeout, so a slow CI machine does not flake.
  await expect(page).not.toHaveURL(/\/login$/)
}

/** Horizontal overflow, in pixels. Zero means nothing spills past the viewport width. */
export async function horizontalOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
}

/** Open the seeded event from the events list. */
export async function openSeededEvent(page, eventName) {
  await page.getByRole('link', { name: 'Open plan' }).first().click()
  await expect(page.getByTestId('event-name')).toHaveText(eventName)
}

/**
 * Assert a group appears in the group list.
 *
 * Scoped to the list rather than a bare getByText: a group's name legitimately appears twice —
 * once in the list and once as an option in the scheduling dropdown — so an unscoped text match
 * resolves to two elements and Playwright's strict mode fails. The duplicate is correct
 * behaviour, so the locator has to be the thing that changes.
 */
export async function expectGroupListed(page, name) {
  await expect(page.getByTestId('group-name').filter({ hasText: name })).toBeVisible()
}

/** Create a group through the schedule panel and wait for it to be listed. */
export async function addGroup(page, name) {
  await page.getByTestId('group-name-input').fill(name)
  await page.getByTestId('add-group').click()
  await expectGroupListed(page, name)
}

/** Unique per run, so repeated runs against the shared fixture event do not collide. */
export function uniqueName(prefix) {
  return `${prefix} ${Date.now()}-${Math.floor(Math.random() * 1000)}`
}
