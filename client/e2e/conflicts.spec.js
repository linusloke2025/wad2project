import { test, expect } from '@playwright/test'

import { E2E_USERS } from '../../server/src/scripts/e2eFixtures.js'
import { addGroup, openSeededEvent, signIn, uniqueName } from './helpers.js'

/**
 * Journey 5 — the conflict engine, seen by a planner.
 *
 * This is the graded core: the app's whole claim is that it tells a planner where the bottlenecks
 * are, so the journey drives the real UI to produce a conflict and then asserts the planner is
 * told about it, in words rather than only as a number.
 *
 * Conflicts are advisory by design. The journey therefore checks that planning is not blocked —
 * the slot is accepted and the warning appears alongside it — rather than expecting a refusal.
 */

async function schedule(page, groupName, from, to) {
  // Count the slots before submitting. Waiting merely for a slot to be visible would pass
  // instantly on slots an earlier test created, letting the next form be filled while the
  // previous save is still in flight — and the component's post-save form reset then wipes what
  // was typed, so the second assignment silently never happens.
  const before = await page.getByTestId('assignment-slot').count()

  await page.getByTestId('assign-group').selectOption({ label: groupName })
  await page.getByTestId('assign-zone').selectOption({ label: 'Holding Area' })
  await page.getByTestId('assign-start').fill(from)
  await page.getByTestId('assign-end').fill(to)
  await page.getByTestId('add-assignment').click()

  await expect(page.getByTestId('assignment-slot')).toHaveCount(before + 1)
}

const DOUBLE_BOOKING = 'Two groups hold the same zone at overlapping times'

test.describe('Journey 5 — conflict detection', () => {
  // Declared first on purpose. The fixtures are reset before the run, but tests within a run
  // share one event, so the negative case must see only its own well-separated slots and not the
  // overlapping pair the positive case below creates.
  test('does not flag well-separated slots in the same zone', async ({ page }) => {
    await signIn(page, E2E_USERS.planner)
    await openSeededEvent(page, 'E2E Parade')

    const first = uniqueName('Clear A')
    const second = uniqueName('Clear B')
    await addGroup(page, first)
    await addGroup(page, second)

    // Same zone, an hour apart, and long enough to walk between them.
    await schedule(page, first, '2026-03-01T11:00', '2026-03-01T11:15')
    await schedule(page, second, '2026-03-01T12:00', '2026-03-01T12:15')

    // A conflict list that fires on everything is as useless as one that fires on nothing, so
    // the negative case is asserted explicitly rather than assumed.
    await expect(page.getByText(DOUBLE_BOOKING)).toHaveCount(0)
  })

  test('flags two groups holding one zone at overlapping times', async ({ page }) => {
    await signIn(page, E2E_USERS.planner)
    await openSeededEvent(page, 'E2E Parade')

    const first = uniqueName('Overlap A')
    const second = uniqueName('Overlap B')
    await addGroup(page, first)
    await addGroup(page, second)

    await schedule(page, first, '2026-03-01T10:00', '2026-03-01T11:00')
    await schedule(page, second, '2026-03-01T10:30', '2026-03-01T11:30')

    // The planner is told what is wrong, not merely that something is.
    await expect(page.getByText(DOUBLE_BOOKING).first()).toBeVisible()
  })

  test('shows the conflict count as a badge the planner can act on', async ({ page }) => {
    await signIn(page, E2E_USERS.planner)
    await openSeededEvent(page, 'E2E Parade')

    await expect(page.getByTestId('conflict-count')).toBeVisible()
    // Numeric, so the planner sees scale rather than only presence.
    await expect(page.getByTestId('conflict-count')).toHaveText(/^\d+$/)
  })
})
