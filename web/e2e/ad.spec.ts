import { expect, test } from '@playwright/test'
import { adBind, attrRow, blur, connect, exact, queryBar } from './helpers'

// Samba AD from deploy/e2e/docker-compose.yml, seeded by global setup from ad-seed.ldif.
const base = 'DC=corp,DC=example,DC=test'
const alice = `CN=alice,OU=ldaplens,${base}`
const inner = `CN=inner,OU=ldaplens,${base}`
const outer = `CN=outer,OU=ldaplens,${base}`

test('Active Directory (Samba): LDAPS, decoded values, nested groups, edit, password policy', async ({
  page,
}) => {
  // 1-2. Connect over LDAPS (the profile trusts the test CA) and find alice by search.
  await connect(page, 'ad')
  // exact: the other naming contexts (CN=Configuration,...) end with the base.
  await expect(page.getByRole('treeitem', exact(base))).toBeVisible()
  const editor = queryBar(page)
  await editor.click()
  await page.keyboard.type('(sAMAccountName=alice)')
  await page.getByRole('button', exact('Run')).click()
  await expect(page.getByText('1 entry', { exact: true })).toBeVisible()
  await page.getByRole('row', { name: /alice/ }).click()
  await expect(page).toHaveURL(new RegExp(`dn=${encodeURIComponent(alice)}(&|$)`))

  // 3. AD values come decoded: the SID, the account flags, a local time for whenCreated.
  await expect(attrRow(page, 'objectSid')).toContainText(/S-1-5-21-/)
  await expect(attrRow(page, 'userAccountControl')).toContainText('ACCOUNTDISABLE')
  // The card says so up top, from the decoded flags.
  await expect(page.getByText('Disabled', { exact: true })).toBeVisible()
  // The stored generalized time is the value's title; the UI shows it in local time.
  const created = attrRow(page, 'whenCreated').getByTitle(/^\d{14}(\.\d+)?Z$/)
  const stored = (await created.getAttribute('title'))!
  const iso = stored.replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d).*/, '$1-$2-$3T$4:$5:$6Z')
  const local = await page.evaluate((t) => new Date(t).toLocaleString(), iso)
  await expect(created).toBeVisible()
  await expect(created).toHaveText(local)
  await expect(attrRow(page, 'whenCreated')).not.toContainText(stored)

  // 4. Nested membership: inner directly, outer through inner.
  await page.getByRole('tab', { name: 'Membership' }).click()
  await page
    .getByRole('radiogroup', { name: 'Membership depth' })
    .getByRole('radio', exact('Nested'))
    .click()
  const memberOf = (dn: string) =>
    page.getByRole('region', exact('Member of')).locator(`[data-ref="${dn}"]`)
  await expect(memberOf(inner)).toContainText('direct')
  await expect(memberOf(inner)).not.toContainText('via')
  await expect(memberOf(outer)).toContainText('via')
  await expect(memberOf(outer).getByTitle(inner, { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Attributes' }).click()

  // 5. Edit (E), add a description, review (Mod+S) and apply.
  await blur(page)
  await page.keyboard.press('e')
  await expect(page.getByRole('button', exact('Edit'))).toHaveAttribute('aria-pressed', 'true')
  await page.getByLabel('Add attribute', { exact: true }).fill('description')
  const desc = page.getByLabel('description value', { exact: true })
  await desc.fill('set by e2e')
  await desc.press('Enter')
  await blur(page)
  await page.keyboard.press('ControlOrMeta+S')
  const review = page.getByRole('dialog', { name: 'Review changes' })
  await expect(review).toContainText('description: set by e2e')
  await review.getByRole('button', exact('Apply')).click()
  await expect(review).toBeHidden()
  // E again: out of Edit the value is text, not an input.
  await blur(page)
  await page.keyboard.press('e')
  await expect(page.getByRole('button', exact('Edit'))).toHaveAttribute('aria-pressed', 'false')
  await expect(attrRow(page, 'description')).toContainText('set by e2e')

  // 6. Set password: AD's policy refuses 'x' and the dialog says why; a strong one is set.
  await page.getByRole('button', exact('More')).click()
  await page.getByRole('button', exact('Set password…')).click()
  const dialog = page.getByRole('dialog', { name: 'Set password' })
  const setTwice = async (pw: string) => {
    await dialog.getByLabel('New password').fill(pw)
    await dialog.getByLabel('Repeat').fill(pw)
    await dialog.getByRole('button', exact('Set')).click()
  }
  await setTwice('x')
  await expect(dialog).toContainText('password does not meet the policy')
  await expect(dialog).toBeVisible()
  await setTwice('G00d-Passw0rd!')
  await expect(dialog).toBeHidden()
  // alice stays disabled, so no password binds, but AD checks the password first: the new one
  // fails with data 533 (account disabled), any other with data 52e (bad password).
  expect(adBind(alice, 'G00d-Passw0rd!')).toContain('data 533')
  expect(adBind(alice, 'G00d-Passw0rd?')).toContain('data 52e')
})
