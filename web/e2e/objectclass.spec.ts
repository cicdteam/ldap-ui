import { e2eDN } from './fixture'
import { attrRow, openEntry, review } from './helpers'
import { expect, test } from './test'

const editButton = { name: 'Edit', exact: true }
const applyButton = { name: 'Apply to demo', exact: true }
const posixMust = ['uidNumber', 'gidNumber', 'homeDirectory']

test('add an auxiliary class with its MUST attributes, then remove it with them', async ({
  page,
}) => {
  await openEntry(page, 'demo', e2eDN('aux'))
  await page.getByRole('button', editButton).click()
  const oc = attrRow(page, 'objectClass')
  await expect(oc.getByRole('img', { name: 'Structural class cannot be changed' })).toBeVisible()
  await oc.getByLabel('Add object class', { exact: true }).selectOption('posixAccount')
  // The class's MAY names are offered by "+ attribute"; its missing MUSTs are rows to fill instead.
  const offered = (a: string) => page.locator(`[data-add-attribute] datalist option[value="${a}"]`)
  await expect(offered('loginShell')).toHaveCount(1)
  for (const a of posixMust) {
    await expect(attrRow(page, a).getByRole('alert')).toBeVisible()
    await expect(attrRow(page, a).getByRole('alert')).toHaveText('Required by the object class')
    await expect(offered(a)).toHaveCount(0)
  }

  let dialog = await review(page)
  await expect(dialog.getByRole('button', applyButton)).toBeDisabled()
  await page.keyboard.press('Escape')

  for (const [a, v] of [
    ['uidNumber', '7001'],
    ['gidNumber', '7001'],
    ['homeDirectory', '/home/aux'],
  ]) {
    await attrRow(page, a)
      .getByRole('button', { name: `Add ${a} value`, exact: true })
      .click()
    const input = attrRow(page, a).locator('input').last()
    await input.fill(v)
    await input.press('Enter')
    await expect(attrRow(page, a).getByRole('alert')).toHaveCount(0)
  }
  dialog = await review(page)
  await expect(dialog).toContainText('objectClass: posixAccount')
  await dialog.getByRole('button', applyButton).click()
  await expect(dialog).toBeHidden()

  await oc
    .locator('li', { hasText: 'posixAccount' })
    .getByRole('button', { name: 'Delete objectClass value', exact: true })
    .click()
  for (const a of posixMust) {
    await expect(attrRow(page, a).getByRole('alert')).toBeVisible()
    await expect(attrRow(page, a).getByRole('alert')).toHaveText(
      'Not allowed without posixAccount; delete it',
    )
  }
  for (const a of posixMust)
    await attrRow(page, a)
      .getByRole('button', { name: `Delete ${a} value`, exact: true })
      .click()
  dialog = await review(page)
  await dialog.getByRole('button', applyButton).click()
  await expect(dialog).toBeHidden()

  await page.reload()
  await expect(attrRow(page, 'objectClass')).not.toContainText('posixAccount')
  await expect(attrRow(page, 'uidNumber')).toHaveCount(0)
})
