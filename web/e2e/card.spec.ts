import { expect, test, type Page } from '@playwright/test'
import { E2E_OU, e2eDN } from './fixture'
import { attrRow, connect, exact, openEntry, queryBar, valueItems } from './helpers'

const results = (page: Page) => page.getByRole('grid', exact('Search results'))
const section = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${name} \\(\\d+\\)$`) })
const attrs = (page: Page, region: string) =>
  page
    .getByRole('region', exact(region))
    .locator('[data-attr]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-attr')))

test('uid=jdoe: the card leads with who it is, then the Pinned section', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('jdoe'))
  // The name (displayName), the RDN, initials, the DN as breadcrumbs, the class, who changed it.
  await expect(page.getByRole('heading', exact('John Doe'))).toBeVisible()
  await expect(page.locator('#card-heading + span')).toHaveText('uid=jdoe')
  await expect(page.getByText('JD', { exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', exact('DN path')).getByRole('button')).toHaveText([
    'dc=example,dc=org',
    'ou=e2e',
    'uid=jdoe',
  ])
  await expect(page.getByText('inetOrgPerson', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/^Modified .+ by \S+=/)).toBeVisible()
  for (const name of ['Edit', 'Add to group', 'Copy DN', 'More', 'Copy DN from the path'])
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()

  // Pinned first, in the person's order, and not repeated below; Operational starts closed.
  await expect(page.locator('[role=tabpanel] button[aria-expanded]')).toHaveText([
    /^Pinned \(6\)/,
    /^Required/,
    /^Optional/,
    /^Operational/,
  ])
  expect(await attrs(page, 'Pinned')).toEqual([
    'cn',
    'uid',
    'mail',
    'title',
    'manager',
    'telephoneNumber',
  ])
  expect(await attrs(page, 'Required')).toEqual(['objectClass', 'sn'])
  await expect(attrRow(page, 'cn')).toHaveCount(1)
  await expect(section(page, 'Operational')).toHaveAttribute('aria-expanded', 'false')
  await expect(attrRow(page, 'entryUUID')).toBeHidden()
  // A value shows its copy button on hover; a one-value row is 30 px tall; DN values are links.
  const copy = attrRow(page, 'manager').getByRole('button', exact('Copy manager value'))
  await expect(copy.locator('..')).toHaveCSS('opacity', '0')
  await valueItems(page, 'manager').hover()
  await expect(copy.locator('..')).toHaveCSS('opacity', '1')
  expect((await attrRow(page, 'uid').boundingBox())!.height).toBe(30)
  await attrRow(page, 'manager')
    .getByRole('button', exact(`uid=jane.doe,${E2E_OU}`))
    .click()
  await expect(page.getByRole('heading', exact('Jane Doe'))).toBeVisible()

  // Add to group: Edit on, the Membership tab, its add field focused.
  await page.getByRole('button', exact('Add to group')).click()
  await expect(page.getByRole('button', exact('Edit'))).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('tab', exact('Membership'))).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('Add to group', { exact: true })).toBeFocused()
})

test('the tab, Nested, Operational and the attribute filter stay from entry to entry; Edit does not', async ({
  page,
}) => {
  await connect(page, 'demo')
  await queryBar(page).click()
  await page.keyboard.insertText('(|(uid=jdoe)(uid=jane.doe))')
  await page.keyboard.press('Enter')
  const rows = results(page).getByRole('row')
  // The header, the e2e Jane and John, and the demo's cn=Doe\, John (uid jdoe too).
  await expect(rows).toHaveCount(4)
  const dns = await Promise.all([1, 2].map(async (i) => (await rows.nth(i).getAttribute('title'))!))
  const at = (dn: string) => expect.poll(() => new URL(page.url()).searchParams.get('dn')).toBe(dn)

  // Operational open, then Down.
  await rows.nth(1).click()
  await at(dns[0])
  await section(page, 'Operational').click()
  await rows.nth(1).click()
  await page.keyboard.press('ArrowDown')
  await at(dns[1])
  await expect(section(page, 'Operational')).toHaveAttribute('aria-expanded', 'true')
  await expect(attrRow(page, 'entryUUID')).toBeVisible()

  // The attribute filter, then Up.
  const filter = page.getByLabel('Filter attributes and values')
  await filter.fill('mail')
  await expect(attrRow(page, 'sn')).toHaveCount(0)
  await rows.nth(2).click()
  await page.keyboard.press('ArrowUp')
  await at(dns[0])
  await expect(filter).toHaveValue('mail')
  await expect(attrRow(page, 'mail')).toBeVisible()
  await expect(attrRow(page, 'sn')).toHaveCount(0)

  // Edit on (it opens Attributes), then Membership with Nested; Down keeps the last two and ends
  // Edit.
  const edit = page.getByRole('button', exact('Edit'))
  await edit.click()
  await expect(edit).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('tab', exact('Membership')).click()
  const nested = page
    .getByRole('radiogroup', exact('Membership depth'))
    .getByRole('radio', exact('Nested'))
  await nested.click()
  await rows.nth(1).click()
  await page.keyboard.press('ArrowDown')
  await at(dns[1])
  await expect(page.getByRole('tab', exact('Membership'))).toHaveAttribute('aria-selected', 'true')
  await expect(nested).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('region', exact('Member of'))).toBeVisible()
  await expect(edit).toHaveAttribute('aria-pressed', 'false')
})

test('a closed section opens while one of its rows has a problem', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('sections'))
  await page.getByRole('button', exact('Edit')).click()
  const optional = section(page, 'Optional')
  await optional.click()
  await expect(optional).toHaveAttribute('aria-expanded', 'false')
  await expect(attrRow(page, 'loginShell')).toBeHidden()

  // Removing posixAccount leaves its loginShell, in Optional, not allowed.
  await attrRow(page, 'objectClass')
    .locator('li', { hasText: 'posixAccount' })
    .getByRole('button', exact('Delete objectClass value'))
    .click()
  await expect(optional).toHaveAttribute('aria-expanded', 'true')
  await expect(optional).toBeDisabled()
  await expect(attrRow(page, 'loginShell').getByRole('alert')).toHaveText(
    'Not allowed without posixAccount; delete it',
  )

  // Fixed, it closes again as it was left.
  await attrRow(page, 'loginShell').getByRole('button', exact('Delete loginShell value')).click()
  await expect(optional).toHaveAttribute('aria-expanded', 'false')
})
