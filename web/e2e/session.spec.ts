import { e2eDN, E2E_OU } from './fixture'
import { exact, signIn } from './helpers'
import { expect, test } from './test'

test('a lost session asks to connect again and returns to the same entry', async ({ page }) => {
  // A typed password lives in the browser's session only (demo-pw has none configured).
  await signIn(page, 'demo-pw', { password: 'adminpassword' })
  await page.goto(`c/demo-pw/entry?dn=${encodeURIComponent(e2eDN('read'))}`)
  await expect(page.locator('#card-heading + span')).toHaveText('uid=read')

  // The connection goes behind the UI's back, as when the session expires.
  const res = await page.request.post('api/disconnect', { data: { profile: 'demo-pw' } })
  expect(res.status()).toBe(204)

  // Another entry: its read is refused, and the app asks to connect again.
  await page.getByRole('navigation', exact('DN path')).getByRole('button', exact('ou=e2e')).click()
  await expect(
    page.getByText('The session for demo-pw ended. Connect again to continue.'),
  ).toBeVisible()
  const password = page.getByRole('dialog').getByLabel('Password for cn=admin,dc=example,dc=org')
  await password.fill('adminpassword')
  await password.press('Enter')

  await expect(page).toHaveURL(`c/demo-pw/entry?dn=${encodeURIComponent(E2E_OU)}`)
  await expect(page.locator('#card-heading')).toHaveText('e2e')
})
