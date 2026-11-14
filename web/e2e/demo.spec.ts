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

// deploy/demo-ldif/ad-demo.ldif, which global setup loads into the e2e Samba.
test('AD demo: nested groups, a group above 1500 members, decoded account flags', async ({
  page,
}) => {
  const ad = 'DC=corp,DC=example,DC=test'
  const user001 = `CN=User 001,OU=People,OU=Demo,${ad}`
  const group = (name: string) => `CN=${name},OU=Groups,OU=Demo,${ad}`
  await openEntry(page, 'ad', user001)
  await expect(attrRow(page, 'userAccountControl')).toContainText('NORMAL_ACCOUNT')
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
