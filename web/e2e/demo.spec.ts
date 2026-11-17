import { expect, test } from '@playwright/test'
import { BASE } from './fixture'
import { adBind, attrRow, openEntry, valueItems } from './helpers'

// The demo directory (deploy/demo-ldif/demo.ldif) is loaded before the e2e fixture.
const user = (n: string) => `uid=user${n},ou=people,${BASE}`

test('demo people show photos, a certificate and values with language options', async ({
  page,
}) => {
  await openEntry(page, 'demo', user('001'))
  await expect(attrRow(page, 'jpegPhoto').locator('img')).toBeVisible()
  await expect(attrRow(page, 'userCertificate;binary')).toContainText(/binary, \d+ bytes/)
  await expect(attrRow(page, 'cn')).toContainText('User 001')
  await expect(attrRow(page, 'cn;lang-de')).toContainText('Benutzer 001')
  await expect(attrRow(page, 'description;lang-ru')).toContainText('Пользователь 001')
  await page.goto(`c/demo/entry?dn=${encodeURIComponent(user('020'))}`)
  await expect(attrRow(page, 'jpegPhoto').locator('img')).toBeVisible()
})

test('the LDIF tab shows non-ASCII values decoded; Copy LDIF keeps them base64', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openEntry(page, 'demo', user('001'))
  await page.getByRole('tab', { name: 'LDIF' }).click()
  const panel = page.getByRole('tabpanel', { name: 'LDIF' })
  await expect(panel).toContainText('description;lang-ru: Пользователь 001')
  await expect(panel).toContainText('utf-8')
  const encoded = Buffer.from('Пользователь 001').toString('base64')
  await expect(panel).not.toContainText(encoded)
  await page.getByRole('button', { name: 'Copy LDIF', exact: true }).click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toContain(`description;lang-ru:: ${encoded}`)
  // A text selection copies the decoded values without the utf-8 mark.
  await panel.locator('pre').selectText()
  const selected = await page.evaluate(() => getSelection()?.toString() ?? '')
  expect(selected).toContain('description;lang-ru: Пользователь 001')
  expect(selected).not.toContain('utf-8')
})

// deploy/demo-ldif/ad-demo.ldif, which global setup loads into the e2e Samba.
test('AD demo: nested groups, a group above 1500 members, decoded account flags', async ({
  page,
}) => {
  const ad = 'DC=corp,DC=example,DC=test'
  const user001 = `CN=User 001,OU=People,OU=Demo,${ad}`
  const group = (name: string) => `CN=${name},OU=Groups,OU=Demo,${ad}`
  await openEntry(page, 'ad', user001)
  await expect(attrRow(page, 'userAccountControl')).toContainText('NORMAL_ACCOUNT')
  await expect(page.getByText('Disabled', { exact: true })).toHaveCount(0)
  await expect(attrRow(page, 'objectSid')).toContainText(/S-1-5-21-/)
  // Everyone through Staff, which holds Engineering, which holds user001.
  await page.getByRole('tab', { name: 'Membership' }).click()
  await page
    .getByRole('radiogroup', { name: 'Membership depth' })
    .getByRole('radio', { name: 'Nested', exact: true })
    .click()
  const everyone = page
    .getByRole('region', { name: 'Member of', exact: true })
    .locator(`[data-ref="${group('Everyone')}"]`)
  await expect(everyone).toContainText('via')
  await expect(everyone.getByTitle(group('Staff'), { exact: true })).toBeVisible()
  await page.goto(`c/ad/entry?dn=${encodeURIComponent(group('All Bulk'))}`)
  await expect(valueItems(page, 'member')).toHaveCount(100)
  await expect(
    attrRow(page, 'member').getByRole('button', { name: 'Show 1000 more (1600 total)' }),
  ).toBeVisible()
  // The demo password works for an enabled demo user.
  expect(adBind(user001, 'Demo-Passw0rd!')).toBe('')
})
