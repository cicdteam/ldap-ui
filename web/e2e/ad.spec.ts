import { adBind, attrRow, blur, connect, exact, queryBar, review } from './helpers'
import { expect, test } from './test'

// Samba AD from deploy/e2e/docker-compose.yml, seeded by global setup from ad-seed.ldif.
const base = 'DC=corp,DC=example,DC=test'
const alice = `CN=alice,OU=ldaplens,${base}`
const inner = `CN=inner,OU=ldaplens,${base}`
const outer = `CN=outer,OU=ldaplens,${base}`

test('Active Directory (Samba): LDAPS, decoded values, nested groups, edit, password policy', async ({
  page,
}) => {
  await test.step('connect over LDAPS (the profile trusts the test CA), find alice', async () => {
    await connect(page, 'ad')
    // exact: the other naming contexts (CN=Configuration,...) end with the base.
    await expect(page.getByRole('treeitem', exact(base))).toBeVisible()
    await queryBar(page).click()
    await page.keyboard.type('(sAMAccountName=alice)')
    await page.getByRole('button', exact('Run')).click()
    await expect(page.getByText('1 entry', { exact: true })).toBeVisible()
    await page.getByRole('row', { name: /alice/ }).click()
    await expect(page).toHaveURL(new RegExp(`dn=${encodeURIComponent(alice)}(&|$)`))
  })

  await test.step('AD values come decoded: the SID, the account flags, local time', async () => {
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
  })

  await test.step('nested membership: inner directly, outer through inner', async () => {
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
  })

  await test.step('edit (E), add a description, review (Mod+S) and apply', async () => {
    await blur(page)
    await page.keyboard.press('e')
    await expect(page.getByRole('button', exact('Edit'))).toHaveAttribute('aria-pressed', 'true')
    await page.getByLabel('Add attribute', { exact: true }).fill('description')
    const desc = page.getByLabel('description value', { exact: true })
    await desc.fill('set by e2e')
    await desc.press('Enter')
    const dialog = await review(page)
    await expect(dialog).toContainText('description: set by e2e')
    await dialog.getByRole('button', exact('Apply to ad')).click()
    await expect(dialog).toBeHidden()
    // E again: out of Edit the value is text, not an input.
    await blur(page)
    await page.keyboard.press('e')
    await expect(page.getByRole('button', exact('Edit'))).toHaveAttribute('aria-pressed', 'false')
    await expect(attrRow(page, 'description')).toContainText('set by e2e')
  })

  await test.step("set password: AD's policy refuses 'x' and says why; a strong one is set", async () => {
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
})
