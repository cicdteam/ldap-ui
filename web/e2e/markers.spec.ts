import { expect, test } from '@playwright/test'
import { e2eDN } from './fixture'
import { attrRow, openEntry } from './helpers'

// exact: the breadcrumb "uid=markers" is a button, and other names may contain "edit".
const editButton = { name: 'Edit', exact: true }

test('markers, header count, invalid badge, dot in results', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('markers'))
  await page.getByRole('button', editButton).click()
  const desc = attrRow(page, 'description').locator('input').first()
  await desc.fill('changed text')
  await desc.press('Enter')
  await expect(attrRow(page, 'description').getByLabel('deleted')).toBeVisible()
  await expect(attrRow(page, 'description').getByLabel('changed')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review 1 change' })).toBeVisible()
  await expect(
    page.getByRole('treeitem', { name: /markers/ }).getByLabel('Has unapplied changes'),
  ).toBeVisible()
  await attrRow(page, 'sn').getByRole('button', { name: 'Delete sn value' }).click()
  await expect(attrRow(page, 'sn').getByRole('alert')).toHaveText('Required by the object class')
  await expect(page.getByRole('button', { name: 'Review 2 changes' })).toHaveAttribute(
    'data-invalid',
    '',
  )
  await attrRow(page, 'sn').getByRole('button', { name: 'Restore sn value' }).click()
  await expect(attrRow(page, 'sn').getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', editButton).click()
  await expect(attrRow(page, 'description').getByLabel('changed')).toBeVisible()
  const editor = page.locator('.cm-content[aria-label="LDAP filter"]')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('(uid=markers)')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(
    page.getByRole('row', { name: /markers/ }).getByLabel('Has unapplied changes'),
  ).toBeVisible()
})
