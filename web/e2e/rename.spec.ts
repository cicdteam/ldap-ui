import { expect, test } from '@playwright/test'
import { E2E_OU, e2eDN, e2eOU } from './fixture'
import { attrRow, blur, openEntry } from './helpers'

test('rename within the parent, then move to another OU', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('renamer'))
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('button', { name: 'Rename/Move', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename or move' })
  const apply = dialog.getByRole('button', { name: 'Apply', exact: true })
  const rdn = dialog.getByLabel('New RDN', { exact: true })
  const parent = dialog.getByLabel('New parent', { exact: true })
  await expect(rdn).toHaveValue('uid=renamer')
  await expect(parent).toHaveValue(E2E_OU)
  await expect(apply).toBeDisabled()
  await rdn.fill('uid=renamed')
  await expect(dialog).toContainText(`uid=renamed,${E2E_OU}`)
  await dialog.getByText('LDIF', { exact: true }).click()
  await expect(dialog).toContainText('changetype: modrdn')
  await expect(dialog).toContainText('deleteoldrdn: 1')
  await expect(dialog).not.toContainText('newsuperior')
  await apply.click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/dn=uid%3Drenamed%2Cou%3De2e/)
  await expect(attrRow(page, 'uid')).toContainText('renamed')
  await expect(attrRow(page, 'uid')).not.toContainText('renamer')

  // F2 opens the same dialog; an entry cannot move below itself.
  await blur(page)
  await page.keyboard.press('F2')
  await parent.fill(`ou=x,uid=renamed,${E2E_OU}`)
  await expect(apply).toBeDisabled()
  await expect(dialog).toContainText('An entry cannot move below itself')
  await parent.fill(e2eOU('moveto'))
  await apply.click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/dn=uid%3Drenamed%2Cou%3Dmoveto/)
  await expect(attrRow(page, 'uid')).toContainText('renamed')
})
