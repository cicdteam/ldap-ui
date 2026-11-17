import { profileButton } from './helpers'
import { expect, test } from './test'

// A browser that only has the login link: none of the bearer header playwright.config.ts sends.
test.use({ extraHTTPHeaders: {} })

test('the login link signs the browser in and leaves the address bar; without the cookie the app asks for the link', async ({
  page,
  context,
}) => {
  expect((await page.goto('./'))?.status()).toBe(401)

  // The token e2e/serve.sh starts the server with.
  await page.goto('./?token=e2e-token-000000000')
  await expect(page).toHaveURL('http://127.0.0.1:18091/ldap/')
  await expect(profileButton(page, 'demo')).toBeVisible()
  await expect(page.getByText('yaml', { exact: true }).first()).toBeVisible()
  await page.reload()
  await expect(profileButton(page, 'demo')).toBeVisible()

  // The cookie gone, the next request is refused and the app says how to get back in.
  await context.clearCookies()
  await profileButton(page, 'demo').click()
  await expect(page.getByRole('heading', { name: 'Login link required' })).toBeVisible()
})
