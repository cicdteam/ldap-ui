import { expect, test, type Page } from '@playwright/test'

// The e2e server runs in local mode: these specs stub what the UI reads to
// tell the modes apart and the profile list, and answer the connect with an
// untrusted certificate, so they reach no directory.

/** A tls_untrusted connect in local mode: one self-signed certificate. */
const untrusted = {
  code: 'tls_untrusted',
  message: 'the server certificate is not trusted',
  certificates: [
    {
      subject: 'CN=ldap.example.test',
      issuer: 'CN=ldap.example.test',
      notAfter: '2030-01-01T00:00:00Z',
      sha256: 'ab'.repeat(32),
      pem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    },
  ],
}

/** The same in server mode, which shows nothing about the directory before sign-in. */
const untrustedServer = {
  code: 'tls_untrusted',
  message: "the directory server's certificate is not trusted",
}

async function stub(page: Page, mode: 'local' | 'server', profiles: object[]) {
  await page.route('**/api/server', (r) => r.fulfill({ json: { mode } }))
  await page.route('**/api/profiles', (r) => r.fulfill({ json: profiles }))
  await page.route('**/api/connect', (r) =>
    r.fulfill({ status: 502, json: mode === 'server' ? untrustedServer : untrusted }),
  )
  const loaded = page.waitForResponse('**/api/server')
  await page.goto('./')
  await loaded
}

const row = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${name}(?![\\w-])`) })

test('server mode shows no saving and no trust', async ({ page }) => {
  // What server mode sends: no URL, bind DN, TLS settings or editable flag.
  await stub(page, 'server', [
    { name: 'team', readOnly: false, connected: false, userLogin: true, needsPassword: true },
    { name: 'fixed', readOnly: true, connected: false, userLogin: false, needsPassword: true },
  ])
  await expect(row(page, 'team')).toBeVisible()
  await expect(page.getByRole('button', { name: 'New connection' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0)
  await expect(page.getByText('yaml', { exact: true })).toHaveCount(0)

  // A bind DN the UI is not told: the field is just "Password", and password
  // managers key it by the profile name.
  await row(page, 'fixed').click()
  let dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Password', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('Username')).toHaveCount(0)
  await expect(dialog.locator('input[autocomplete=username]')).toHaveValue('fixed')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  await row(page, 'team').click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('Username').fill('user001')
  const password = dialog.getByLabel('Password', { exact: true })
  await password.fill('secret001')
  await password.press('Enter')
  await expect(dialog.getByRole('alert')).toContainText(untrustedServer.message)
  await expect(dialog.getByText('Server certificate', { exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Trust this CA and connect' })).toHaveCount(0)
})

test('local mode offers saving and trust', async ({ page }) => {
  await stub(page, 'local', [
    {
      name: 'lab',
      url: 'ldaps://lab.example.test',
      startTLS: false,
      insecureSkipVerify: false,
      readOnly: false,
      editable: true,
      hasPassword: false,
      connected: false,
      userLogin: false,
      needsPassword: false,
    },
  ])
  await expect(page.getByRole('button', { name: 'New connection' })).toBeVisible()
  await row(page, 'lab').click()
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Trust this CA and connect' }),
  ).toBeVisible()
})
