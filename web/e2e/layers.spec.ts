import { expect, test, type Page } from '@playwright/test'
import { blur, connect } from './helpers'

type Point = { x: number; y: number }

/**
 * Whether the topmost painted element at p (the results header) belongs to a modal layer, not the
 * grid. A modal sets pointer-events: none on body, which elementFromPoint skips, so it is lifted for
 * the probe: the question is what is painted on top, not what takes clicks.
 */
function covered(page: Page, p: Point): Promise<boolean> {
  return page.evaluate(({ x, y }) => {
    const prev = document.body.style.pointerEvents
    document.body.style.pointerEvents = 'auto'
    try {
      return !document.elementFromPoint(x, y)?.closest('[role=grid]')
    } finally {
      document.body.style.pointerEvents = prev
    }
  }, p)
}

// The sticky results header has its own stacking layer; dialogs must still cover it.
test('dialogs and the palette cover the sticky results header', async ({ page }) => {
  await connect(page, 'demo')
  await page.goto('c/demo/search?filter=(objectClass=inetOrgPerson)')
  await page.getByRole('row').nth(2).click()
  // Measured before a modal opens: Radix then hides the page from the accessibility tree.
  const box = await page.getByRole('columnheader', { name: 'Name', exact: true }).boundingBox()
  if (!box) throw new Error('results header not visible')
  const header = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  expect(await covered(page, header)).toBe(false)

  await page.keyboard.press('ControlOrMeta+K')
  await expect(page.locator('[cmdk-input]')).toBeVisible()
  expect(await covered(page, header)).toBe(true)
  await page.keyboard.press('Escape')

  await blur(page)
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog', { name: 'Delete entry' })).toBeVisible()
  expect(await covered(page, header)).toBe(true)
  await page.keyboard.press('Escape')
})
