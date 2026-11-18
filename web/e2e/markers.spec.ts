import { e2eDN } from './fixture'
import { attrRow, openEntry, pendingBar, queryBar, reviewButton } from './helpers'
import { expect, test } from './test'

// exact: the breadcrumb "uid=markers" is a button, and other names may contain "edit".
const editButton = { name: 'Edit', exact: true }

test('markers, pending count, invalid warning, dot in results', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('markers'))
  await page.getByRole('button', editButton).click()
  const desc = attrRow(page, 'description').locator('input').first()
  await desc.fill('changed text')
  await desc.press('Enter')
  await expect(attrRow(page, 'description').getByLabel('deleted')).toBeVisible()
  await expect(attrRow(page, 'description').getByLabel('changed')).toBeVisible()
  await expect(pendingBar(page)).toContainText('1 change in')
  await expect(
    page.getByRole('treeitem', { name: /markers/ }).getByLabel('Has unapplied changes'),
  ).toBeVisible()
  await attrRow(page, 'sn').getByRole('button', { name: 'Delete sn value' }).click()
  await expect(attrRow(page, 'sn').getByRole('alert')).toHaveText('Required by the object class')
  await expect(pendingBar(page)).toContainText('2 changes in 1 entry')
  await expect(pendingBar(page)).toContainText('Some changes fail validation')
  await expect(reviewButton(page)).toHaveAttribute('data-invalid', '')
  await attrRow(page, 'sn').getByRole('button', { name: 'Restore sn value' }).click()
  await expect(attrRow(page, 'sn').getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', editButton).click()
  await expect(attrRow(page, 'description').getByLabel('changed')).toBeVisible()
  const editor = queryBar(page)
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('(uid=markers)')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(
    page.getByRole('row', { name: /markers/ }).getByLabel('Has unapplied changes'),
  ).toBeVisible()
})
