import { E2E_OU, e2eDN } from './fixture'
import { attrRow, blur, exact, ldapmodify, openEntry, pendingBar, reviewButton } from './helpers'
import { expect, test, type Page } from './test'

const createButton = { name: 'Create', exact: true }

async function openNewChild(page: Page) {
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('button', { name: 'New child', exact: true }).click()
  return page.getByRole('dialog', { name: 'New child entry' })
}

test('create an OU, a person in it, and refuse the same person twice', async ({ page }) => {
  const ou = `ou=created,${E2E_OU}`
  const person = `uid=newbie,${ou}`
  await openEntry(page, 'demo', E2E_OU)
  const ouDialog = await openNewChild(page)
  await ouDialog.getByLabel('Structural class').selectOption('organizationalUnit')
  await expect(ouDialog.getByLabel('RDN attribute')).toHaveValue('ou')
  await ouDialog.getByLabel('RDN value').fill('created')
  await expect(ouDialog).toContainText(ou)
  await ouDialog.getByRole('button', createButton).click()
  await expect(ouDialog).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`dn=${encodeURIComponent(ou)}`))

  const dialog = page.getByRole('dialog', { name: 'New child entry' })
  const createPerson = async () => {
    // N opens the same dialog from the keyboard.
    await blur(page)
    await page.keyboard.press('n')
    await dialog.getByLabel('Structural class').selectOption('inetOrgPerson')
    await expect(dialog.getByLabel('RDN attribute')).toHaveValue('uid')
    await dialog.getByLabel('RDN value').fill('newbie')
    const create = dialog.getByRole('button', createButton)
    await expect(create).toBeDisabled()
    await expect(dialog.locator('[data-attr="sn"]').getByRole('alert')).toHaveText(
      'Required by the object class',
    )
    await dialog.getByLabel('cn value', { exact: true }).fill('New Bie')
    await dialog.getByLabel('sn value', { exact: true }).fill('Bie')
    // What is typed counts at once: no Enter or Tab before Create.
    await create.click()
  }
  await createPerson()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`dn=${encodeURIComponent(person)}`))
  await expect(attrRow(page, 'cn')).toContainText('New Bie')
  await expect(attrRow(page, 'uid')).toContainText('newbie')

  await page.goto(`c/demo/entry?dn=${encodeURIComponent(ou)}`)
  await expect(page.locator('[data-attr]').first()).toBeVisible()
  await createPerson()
  await expect(dialog.getByRole('alert')).toContainText(/already exists/i)
  await expect(dialog).toBeVisible()
})

test('a bidi control in a name shows as <U+202E>; Copy DN keeps the real one', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const dn = `ou=\u202Enimda,${E2E_OU}`
  const shown = 'ou=<U+202E>nimda'
  await openEntry(page, 'demo', E2E_OU)
  const dialog = await openNewChild(page)
  await dialog.getByLabel('Structural class').selectOption('organizationalUnit')
  await dialog.getByLabel('RDN value').fill('\u202Enimda')
  await expect(dialog).toContainText(`${shown},${E2E_OU}`)
  await dialog.getByRole('button', createButton).click()
  await expect(dialog).toBeHidden()
  try {
    await expect(page).toHaveURL(new RegExp(`dn=${encodeURIComponent(dn)}`))
    await expect(page.getByRole('treeitem', { name: shown })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByRole('heading', exact('<U+202E>nimda'))).toBeVisible()
    await expect(
      page.getByRole('navigation', exact('DN path')).getByRole('button').last(),
    ).toHaveText(shown)
    await page.getByRole('button', exact('Copy DN from the path')).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(dn)

    await page.getByRole('button', exact('Edit')).click()
    await page.getByLabel('Add attribute', { exact: true }).fill('description')
    const desc = page.getByLabel('description value', { exact: true })
    await desc.fill('staged')
    await desc.press('Enter')
    await reviewButton(page).click()
    const review = page.getByRole('dialog', { name: 'Review changes' })
    await expect(review).toContainText(`${shown},${E2E_OU}`)
    page.once('dialog', (d) => void d.accept())
    await review.getByRole('button', exact('Discard all')).click()
    await expect(pendingBar(page)).toBeHidden()
  } finally {
    // Gone again, so the specs after this one list ou=e2e as seeded.
    ldapmodify(`dn:: ${Buffer.from(dn).toString('base64')}\nchangetype: delete\n`)
  }
})

test('clone leaves the RDN, uid and mail out, and holds while it writes', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('clonesrc'))
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('button', { name: 'Clone', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Clone entry' })
  const rdn = dialog.getByLabel('RDN value')
  await expect(rdn).toBeFocused()
  await expect(rdn).toHaveValue('')
  await expect(dialog.getByLabel('Structural class')).toHaveValue('inetOrgPerson')
  await expect(dialog.getByLabel('cn value', { exact: true })).toHaveValue('E2E clonesrc')
  await expect(dialog.locator('[data-attr="mail"]')).toHaveCount(0)
  await expect(dialog.locator('[data-attr="uid"]')).toHaveCount(0)
  await rdn.fill('clonecopy')

  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/entries/add', async (route) => {
    await held
    await route.continue()
  })
  const create = dialog.getByRole('button', createButton)
  await create.click()
  await expect(create).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  release()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/dn=uid%3Dclonecopy%2Cou%3De2e/)
  await expect(attrRow(page, 'cn')).toContainText('E2E clonesrc')
  await expect(attrRow(page, 'mail')).toHaveCount(0)
})
