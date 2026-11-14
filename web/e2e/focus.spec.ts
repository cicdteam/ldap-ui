import { expect, test, type Locator, type Page } from '@playwright/test'
import { connect } from './helpers'

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
  const columns = page.getByLabel('Columns')
  const unfocused = page.locator('input.input-look:not(:focus)').first()
  const content = page.locator('.cm-content[aria-label="LDAP filter"]')
  const editor = page.locator('.cm-editor.cm-focused')

  // Normal mode: input-look fields and the editor show a ring, the rest the global outline.
  await keyFocus(page, columns)
  await expect(columns).toHaveCSS('outline-style', 'none')
  await expect(columns).not.toHaveCSS('box-shadow', 'none')
  await keyFocus(page, content)
  await page.keyboard.type('(cn=x)')
  await expect(editor).not.toHaveCSS('box-shadow', 'none')
  await page.getByRole('radio', { name: 'builder', exact: true }).click()
  const negate = page.getByRole('checkbox', { name: 'NOT' })
  await keyFocus(page, negate)
  await hasOutline(negate)
  await page.getByRole('radio', { name: 'text', exact: true }).click()

  // Forced colors: the ring is gone, a transparent outline the browser paints stands in.
  await page.emulateMedia({ forcedColors: 'active' })
  await keyFocus(page, columns)
  await hasOutline(columns)
  await expect(unfocused).toHaveCSS('outline-style', 'none')
  await keyFocus(page, content)
  await hasOutline(editor)
})
