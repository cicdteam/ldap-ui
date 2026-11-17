import { E2E_OU, e2eDN, e2eOU } from './fixture'
import { blur, openEntry } from './helpers'
import { expect, test } from './test'

const deleteButton = { name: 'Delete', exact: true }

test('delete: a container with children stays; a leaf goes after typing its RDN', async ({
  page,
}) => {
  await openEntry(page, 'demo', e2eOU('full'))
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('button', deleteButton).click()
  const dialog = page.getByRole('dialog', { name: 'Delete entry' })
  await expect(dialog).toContainText('Has 1 child. Delete it first.')
  await expect(dialog.getByRole('button', deleteButton)).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  // Mod+Backspace, the Finder's key, opens it too.
  await blur(page)
  await page.keyboard.press('ControlOrMeta+Backspace')
  await expect(dialog).toContainText('Has 1 child. Delete it first.')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await page.goto(`c/demo/entry?dn=${encodeURIComponent(e2eDN('deleteme'))}`)
  await expect(page.locator('[data-attr]').first()).toBeVisible()
  await blur(page)
  await page.keyboard.press('Delete')
  const del = dialog.getByRole('button', deleteButton)
  const typed = dialog.getByLabel('Type uid=deleteme to confirm')
  await expect(typed).toBeFocused()
  // Again from the menu, with the count cached: the field opens with the dialog and keeps focus.
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('button', deleteButton).click()
  await expect(typed).toBeFocused()
  await typed.fill('uid=deleteme2')
  await expect(del).toBeDisabled()
  await typed.fill(' uid=deleteme ')
  await expect(del).toBeEnabled()
  await del.click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`dn=${encodeURIComponent(E2E_OU)}(&|$)`))
  await page.goto(`c/demo/entry?dn=${encodeURIComponent(e2eDN('deleteme'))}`)
  await expect(page.getByText('No entry at this DN.')).toBeVisible()
})
