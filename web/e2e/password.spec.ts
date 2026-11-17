import { e2eDN } from './fixture'
import { attrRow, blur, canBind, openEntry } from './helpers'
import { expect, test, type Page } from './test'

const setButton = { name: 'Set', exact: true }

async function openSetPassword(page: Page) {
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('button', { name: 'Set password…', exact: true }).click()
  return page.getByRole('dialog', { name: 'Set password' })
}

test('set a password with SSHA and with Password Modify; the entry can bind with it', async ({
  page,
}) => {
  // Spaces and a non-ASCII letter: sent and stored as typed.
  const typed = ' Pass wörd 1 '
  await openEntry(page, 'demo', e2eDN('pwssha'))
  await expect(attrRow(page, 'userPassword')).toHaveCount(0)
  const dialog = await openSetPassword(page)
  const pw = dialog.getByLabel('New password')
  const repeat = dialog.getByLabel('Repeat')
  const set = dialog.getByRole('button', setButton)
  await expect(pw).toBeFocused()
  const hash = dialog.getByRole('radiogroup', { name: 'Hash' })
  await expect(hash.getByRole('radio', { name: 'Server policy (Password Modify)' })).toBeChecked()
  // No LDIF: it would show the password or its hash.
  await expect(dialog.locator('summary', { hasText: 'LDIF' })).toHaveCount(0)
  await expect(set).toBeDisabled()
  await pw.fill(typed)
  await repeat.fill('something else')
  await expect(dialog).toContainText('Passwords do not match')
  await expect(set).toBeDisabled()
  await repeat.fill(typed)
  await hash.getByRole('radio', { name: 'SSHA' }).check()
  await set.click()
  await expect(dialog).toBeHidden()
  await expect(attrRow(page, 'userPassword')).toContainText('hidden (1 value)')
  expect(canBind(e2eDN('pwssha'), typed)).toBe(true)
  expect(canBind(e2eDN('pwssha'), typed.trim())).toBe(false)
  const stored = await page.evaluate(() =>
    JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage)]),
  )
  expect(stored).not.toContain('wörd')

  // P opens the same dialog; Password Modify is the default. P counts only once the schema says
  // the entry can hold a password: its MUST section shows then.
  await page.goto(`c/demo/entry?dn=${encodeURIComponent(e2eDN('pwserver'))}`)
  await expect(page.getByRole('button', { name: /^Required/ })).toBeVisible()
  await blur(page)
  await page.keyboard.press('p')
  await pw.fill(typed)
  await repeat.fill(typed)
  await set.click()
  await expect(dialog).toBeHidden()
  await expect(attrRow(page, 'userPassword')).toContainText('hidden (1 value)')
  expect(canBind(e2eDN('pwserver'), typed)).toBe(true)
})
