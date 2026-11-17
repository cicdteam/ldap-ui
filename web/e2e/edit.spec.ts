import { e2eDN } from './fixture'
import { attrRow, openEntry } from './helpers'
import { expect, test } from './test'

// exact: the breadcrumb "uid=edit" is a button whose name contains "edit".
const editButton = { name: 'Edit', exact: true }

test('edit mode stages value edits that survive a reload', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('edit'))
  await page.getByRole('button', editButton).click()
  const desc = attrRow(page, 'description').locator('input').first()
  await desc.fill('edited description')
  await desc.press('Enter')
  await attrRow(page, 'mail').getByRole('button', { name: 'Add mail value' }).click()
  const fresh = attrRow(page, 'mail').locator('input').last()
  await fresh.fill('second@example.org')
  await fresh.press('Enter')
  await page.getByLabel('Add attribute', { exact: true }).fill('displayName')
  const dn = page.getByLabel('displayName value', { exact: true })
  await dn.fill('Edit Person')
  await dn.press('Enter')
  // displayName is single-valued: no "+ value" button, so its row takes focus.
  await expect(attrRow(page, 'displayName')).toBeFocused()
  await page.reload()
  await expect(attrRow(page, 'description')).toContainText('edited description')
  await expect(attrRow(page, 'mail')).toContainText('second@example.org')
  await expect(attrRow(page, 'displayName')).toContainText('Edit Person')
})

test('keyboard focus stays in the row after a commit; Delete beats a draft', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('focus'))
  await page.getByRole('button', editButton).click()
  const row = attrRow(page, 'description')
  const add = row.getByRole('button', { name: 'Add description value' })
  const desc = row.locator('input').first()
  await desc.fill('focus edit')
  await desc.press('Enter')
  await expect(add).toBeFocused()
  await page.keyboard.press('Enter')
  const fresh = row.locator('input').last()
  await expect(fresh).toBeFocused()
  await fresh.fill('second')
  await fresh.press('Enter')
  await expect(add).toBeFocused()
  // A Delete click with an uncommitted draft deletes the value; the draft is not staged.
  const mail = attrRow(page, 'mail')
  await mail.locator('input').first().fill('draft@example.org')
  await mail.getByRole('button', { name: 'Delete mail value' }).click()
  await expect(mail.getByLabel('deleted')).toHaveCount(1)
  await expect(mail.getByLabel('changed')).toHaveCount(0)
  await expect(mail.getByRole('button', { name: 'Add mail value' })).toBeFocused()
})
