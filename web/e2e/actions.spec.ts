import { E2E_OU, e2eDN, e2eGroup } from './fixture'
import { attrRow, blur, openEntry, palette, paletteItem, postJSON, review } from './helpers'
import { expect, test } from './test'

const actions = { name: 'More', exact: true }
const HINT = 'Apply or discard 1 staged change first'

test('rename and delete wait while the entry or one below it has staged changes', async ({
  page,
}) => {
  await openEntry(page, 'demo', e2eDN('staged'))
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const desc = attrRow(page, 'description').locator('input').first()
  await desc.fill('staged edit')
  await desc.press('Enter')
  await page.getByRole('button', actions).click()
  const menu = page.getByRole('dialog', { name: 'Entry actions' })
  for (const name of ['Rename/Move', 'Delete']) {
    const item = menu.getByRole('button', { name, exact: true })
    await expect(item).toBeDisabled()
    // A screen reader hears why.
    await expect(item).toHaveAccessibleDescription(HINT)
  }
  await expect(menu.getByRole('button', { name: 'Clone', exact: true })).toBeEnabled()
  await expect(menu).toContainText(HINT)
  await page.keyboard.press('Escape')

  // The parent OU counts the change below it; R only opens the menu with the reason.
  await page.goto(`c/demo/entry?dn=${encodeURIComponent(E2E_OU)}`)
  await expect(page.locator('[data-attr]').first()).toBeVisible()
  await blur(page)
  await page.keyboard.press('r')
  await expect(menu).toContainText(HINT)
  await expect(page.getByRole('dialog', { name: 'Rename or move' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await palette(page, 'Rename')
  await expect(paletteItem(page, 'Rename/Move entry')).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')

  // Undo history does not survive the reload above; discarding in Review frees the actions.
  page.once('dialog', (d) => void d.accept())
  await (await review(page)).getByRole('button', { name: 'Discard all' }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', actions).click()
  await expect(menu.getByRole('button', { name: 'Rename/Move', exact: true })).toBeEnabled()
  await expect(menu).not.toContainText(HINT)
})

test('read-only profile: no entry actions, no entry commands, and every write is refused', async ({
  page,
}) => {
  await openEntry(page, 'demo-ro', e2eDN('read'))
  await expect(page.getByText('Read-only connection', { exact: true })).toBeVisible()
  for (const name of ['Edit', 'Add to group'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
  // More keeps what reads: raw values and reload.
  await page.getByRole('button', actions).click()
  await expect(page.getByRole('dialog', { name: 'Entry actions' }).getByRole('button')).toHaveText([
    /^Raw values/,
    'Reload entry',
  ])
  await page.keyboard.press('Escape')
  // Neither entry commands nor batch ones.
  const input = await palette(page)
  for (const name of ['Clone entry', 'Set password…', 'Add to group…', 'Review changes']) {
    await input.fill(name)
    await expect(paletteItem(page, name)).toHaveCount(0)
  }
  await page.keyboard.press('Escape')
  const dn = e2eDN('read')
  const writes: [string, unknown][] = [
    [
      'changes/apply',
      { entries: [{ dn, changes: [{ op: 'add', attr: 'description', values: ['x'] }] }] },
    ],
    [
      'entries/add',
      { dn: `uid=ro,${E2E_OU}`, attributes: [{ name: 'objectClass', values: ['inetOrgPerson'] }] },
    ],
    ['entries/delete', { dn }],
    ['entries/rename', { dn, newRDN: 'uid=ro' }],
    ['entries/password', { dn, password: 'x', method: 'ssha' }],
  ]
  for (const [path, body] of writes)
    expect(await postJSON(page, `api/c/demo-ro/${path}`, body)).toEqual({
      status: 403,
      code: 'read_only',
    })

  // Membership has no edit controls either.
  await page.goto(`c/demo-ro/entry?dn=${encodeURIComponent(e2eGroup('drop-team'))}`)
  await page.getByRole('tab', { name: 'Membership' }).click()
  const members = page.getByRole('region', { name: 'Members', exact: true })
  await expect(members.locator('[data-ref]').first()).toBeVisible()
  await expect(
    page.getByRole('button', { name: /^(Add to group|Add member|Remove )/ }),
  ).toHaveCount(0)
})
