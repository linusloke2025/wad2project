import { test, expect } from '@playwright/test'

import { E2E_USERS } from '../../server/src/scripts/e2eFixtures.js'
import { horizontalOverflow, openSeededEvent, signIn, uniqueName } from './helpers.js'

/**
 * Journey 3 — the layout designer.
 *
 * The designer's role only matters if their work reaches the plan other roles see, so this
 * journey drives the real drawing surface rather than asserting a panel exists: corners are
 * tapped, a shape is saved, and the result has to appear.
 *
 * Counts are avoided in favour of named shapes, because this journey adds a shape and the suite
 * shares one event.
 */

test.describe('Journey 3 — layout', () => {
  test('a designer sees the plan and the shapes already on it', async ({ page }) => {
    await signIn(page, E2E_USERS.designer)
    await openSeededEvent(page, 'E2E Parade')

    // The seeded event has two zones and one blocked area, all listed by name.
    await expect(page.getByTestId('shape-list')).toContainText('Main Stage')
    await expect(page.getByTestId('shape-list')).toContainText('Holding Area')
    await expect(page.getByTestId('shape-list')).toContainText('Closed for works')
  })

  test('a designer places a shape by tapping its corners and saving it', async ({ page }) => {
    await signIn(page, E2E_USERS.designer)
    await openSeededEvent(page, 'E2E Parade')

    const surface = page.getByTestId('layout-surface')
    const box = await surface.boundingBox()

    // Three corners of a triangle, tapped in the lower half so they do not collide with the
    // seeded shapes' region.
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.6)
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.6)
    await page.mouse.click(box.x + box.width * 0.68, box.y + box.height * 0.85)

    await expect(page.getByTestId('draft-vertex-count')).toContainText('3 corner(s)')

    const name = uniqueName('Drawn Zone')
    await page.getByTestId('shape-name').fill(name)
    await page.getByTestId('shape-kind').selectOption('blocked')
    await page.getByTestId('save-shape').click()

    await expect(page.getByTestId('designer-notice')).toContainText('Saved')
    await expect(page.getByTestId('shape-list')).toContainText(name)
  })

  test('a shape with fewer than three corners cannot be saved', async ({ page }) => {
    // Two points are a line, not an area, and the conflict engine cannot reason about it.
    await signIn(page, E2E_USERS.designer)
    await openSeededEvent(page, 'E2E Parade')

    const box = await page.getByTestId('layout-surface').boundingBox()
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.7)

    await page.getByTestId('shape-name').fill('Too Few Corners')
    await page.getByTestId('save-shape').click()

    await expect(page.getByTestId('designer-error')).toContainText('three corners')
  })

  test('an unnamed shape cannot be saved', async ({ page }) => {
    await signIn(page, E2E_USERS.designer)
    await openSeededEvent(page, 'E2E Parade')

    const box = await page.getByTestId('layout-surface').boundingBox()
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.7)
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.7)
    await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.8)

    await page.getByTestId('save-shape').click()

    await expect(page.getByTestId('designer-error')).toContainText('name')
  })

  test('a planner sees the same layout read-only, with no drawing controls', async ({ page }) => {
    await signIn(page, E2E_USERS.planner)
    await openSeededEvent(page, 'E2E Parade')

    await expect(page.getByTestId('zone-count')).toBeVisible()
    // A planner plans against the layout; moving zones is the designer's job.
    await expect(page.getByTestId('layout-surface')).toHaveCount(0)
    await expect(page.getByTestId('save-shape')).toHaveCount(0)
  })

  test('the layout panel does not overflow the viewport', async ({ page }) => {
    await signIn(page, E2E_USERS.designer)
    await openSeededEvent(page, 'E2E Parade')

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  })
})
