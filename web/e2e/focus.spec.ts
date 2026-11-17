import { expect, test, type Locator, type Page } from '@playwright/test'
import { connect, exact, queryBar } from './helpers'

/** Focuses loc, then presses a key, so the focus counts as keyboard focus (:focus-visible). */
async function keyFocus(page: Page, loc: Locator): Promise<void> {
  await loc.focus()
  await page.keyboard.press('Shift')
  await expect(loc).toBeFocused()
}

async function hasOutline(loc: Locator): Promise<void> {
  await expect(loc).toHaveCSS('outline-style', 'solid')
  await expect(loc).not.toHaveCSS('outline-width', '0px')
}

// Every focused control shows it, also in forced-colors mode, where box-shadow rings are dropped.
test('focus stays visible, also in forced-colors mode', async ({ page }) => {
  await connect(page, 'demo')
  const scope = page.getByTitle('Search base, scope and columns')
  const column = page.getByLabel('Add a column')
  const unfocused = page.locator('input.input-look:not(:focus)').first()
  const content = queryBar(page)
  // The bar's box draws the ring for its editor.
  const bar = page.getByRole('search')

  // Normal mode: input-look fields and the bar show a ring, the rest the global outline.
  await scope.click()
  await keyFocus(page, column)
  await expect(column).toHaveCSS('outline-style', 'none')
  await expect(column).not.toHaveCSS('box-shadow', 'none')
  await page.keyboard.press('Escape')
  // Closed: the popover has given focus back to its button.
  await expect(scope).toBeFocused()
  await keyFocus(page, content)
  await page.keyboard.type('(cn=x)')
  await expect(bar).not.toHaveCSS('box-shadow', 'none')
  await page.getByRole('button', exact('Filter builder')).click()
  const negate = page.getByRole('checkbox', { name: 'NOT' })
  await keyFocus(page, negate)
  await hasOutline(negate)
  await page.keyboard.press('Escape')

  // Forced colors: the ring is gone, a transparent outline the browser paints stands in.
  await page.emulateMedia({ forcedColors: 'active' })
  await scope.click()
  await keyFocus(page, column)
  await hasOutline(column)
  await expect(unfocused).toHaveCSS('outline-style', 'none')
  await page.keyboard.press('Escape')
  // Closed: the popover has given focus back to its button.
  await expect(scope).toBeFocused()
  await keyFocus(page, content)
  await hasOutline(bar)
})
