import { expect, test, type Page } from '@playwright/test'
import { connect } from './helpers'

// The bindDNTemplate profiles people (OpenLDAP demo data: userNNN, secretNNN) and ad-people
// (Samba demo data: UPN userNNN@corp.example.test, Demo-Passw0rd!) in
// deploy/e2e/connections.yaml.
const person = (n: string) => `uid=user${n},ou=people,dc=example,dc=org`

/** Opens the connect dialog of profile. */
async function openDialog(page: Page, profile: string) {
  await page.goto('./')
  await page.getByRole('button', { name: new RegExp(`^${profile}(?![\\w-])`) }).click()
  const dialog = page.getByRole('dialog')
  return {
    dialog,
    username: dialog.getByLabel('Username'),
    password: dialog.getByLabel('Password', { exact: true }),
  }
}

async function signIn(page: Page, profile: string, username: string, password: string) {
  const d = await openDialog(page, profile)
  await d.username.fill(username)
  await d.password.fill(password)
  await d.password.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/c/${profile}(?:[/?#]|$)`))
}

const signedIn = (page: Page, who: string) =>
  page.locator('header').getByText(`Signed in as ${who}`, { exact: true })

test('two people sign in to one profile', async ({ page, browser }) => {
  // The visible username field replaces the hidden one that holds a fixed bind DN.
  const { dialog, username, password } = await openDialog(page, 'people')
  await expect(dialog.locator('input[autocomplete=username]')).toHaveCount(1)
  await expect(username).toHaveAttribute('autocomplete', 'username')
  await expect(username).toHaveAttribute('required', '')
  await expect(password).toHaveAttribute('required', '')

  const other = await browser.newContext()
  try {
    const page2 = await other.newPage()
    await signIn(page, 'people', 'user001', 'secret001')
    await signIn(page2, 'people', 'user002', 'secret002')
    await expect(signedIn(page, person('001'))).toBeVisible()
    await expect(signedIn(page2, person('002'))).toBeVisible()

    // One person's disconnect leaves the other's connection alone.
    await page2.getByRole('button', { name: 'Disconnect' }).click()
    await expect(page2).toHaveURL(/\/ldap\/?$/)
    await page.reload()
    await expect(page.getByRole('treeitem', { name: /^ou=people/ })).toBeVisible()
    await expect(signedIn(page, person('001'))).toBeVisible()
  } finally {
    await other.close()
  }

  // A fixed bind DN is the profile's, not a person's: no line for it.
  await connect(page, 'demo')
  await expect(page.locator('header').getByTitle('All connections')).toHaveText('demo')
  await expect(page.locator('header').getByText(/^Signed in as/)).toHaveCount(0)
})

// user010 is used here only: its five failures block it for 60 s.
test('wrong password and throttling', async ({ page }) => {
  const { dialog, username, password } = await openDialog(page, 'people')
  await username.fill('user010')
  const attempt = async (status: number) => {
    await password.fill('wrong')
    const res = page.waitForResponse((r) => r.url().endsWith('/api/connect'))
    await password.press('Enter')
    expect((await res).status()).toBe(status)
  }
  for (let i = 0; i < 5; i++) {
    await attempt(401)
    await expect(dialog.getByRole('alert')).toContainText('Invalid Credentials')
  }
  await attempt(429)
  await expect(dialog.getByRole('alert')).toContainText(
    'Too many failed sign-ins. Wait a minute and try again.',
  )
})

test('AD UPN sign-in', async ({ page }) => {
  await signIn(page, 'ad-people', 'user001', 'Demo-Passw0rd!')
  await expect(signedIn(page, 'user001@corp.example.test')).toBeVisible()
})
