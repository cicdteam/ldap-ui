import { expect, test } from '@playwright/test'
import { e2eDN } from './fixture'
import { attrRow, blur, openEntry } from './helpers'

test('Mod+S reviews, Mod+Z undoes, Mod+Shift+Z redoes, disconnect asks', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('keys'))
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const desc = attrRow(page, 'description').locator('input').first()
  await desc.fill('keys edit')
  // Mod+S stages the value being typed, then reviews it.
  await page.keyboard.press('ControlOrMeta+S')
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  await expect(dialog).toContainText('description: keys edit')
  await page.keyboard.press('Escape')
  // In the filter editor (CodeMirror) Mod+Z is the editor's own; Mod+S still reviews.
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('ControlOrMeta+Z')
  await page.keyboard.press('ControlOrMeta+S')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Review 1 change' })).toBeVisible()
  await blur(page)
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(page.getByRole('button', { name: /Review \d+ change/ })).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect(page.getByRole('button', { name: 'Review 1 change' })).toBeVisible()
  page.once('dialog', (d) => void d.dismiss())
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await expect(page).toHaveURL(/\/c\/demo/)
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await expect(page).not.toHaveURL(/\/c\/demo/)
})
