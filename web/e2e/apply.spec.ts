import { expect, test, type Page } from '@playwright/test'
import { e2eDN } from './fixture'
import { attrRow, blur, ldapmodify, openEntry } from './helpers'

// exact: names match as case-insensitive substrings, and breadcrumbs or
// "Copy LDIF for uid=apply1,..." would match too.
const editButton = { name: 'Edit', exact: true }
const applyButton = { name: 'Apply', exact: true }

async function editDescription(page: Page, text: string) {
  await page.getByRole('button', editButton).click()
  const desc = attrRow(page, 'description').locator('input').first()
  await desc.fill(text)
  await desc.press('Enter')
  await page.getByRole('button', editButton).click()
}

/** POSTs a valid one-entry batch straight to changes/apply, bypassing the UI. */
async function applyDirect(page: Page, conn: string, confirm?: string) {
  // The fetch path is relative to <base href>, which is /ldap/.
  return page.evaluate(
    async ({ conn, confirm }) => {
      const r = await fetch(`api/c/${conn}/changes/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm,
          entries: [
            {
              dn: 'uid=x,dc=example,dc=org',
              changes: [{ op: 'add', attr: 'description', values: ['x'] }],
            },
          ],
        }),
      })
      return { status: r.status, code: ((await r.json()) as { code?: string }).code }
    },
    { conn, confirm },
  )
}

test('review shows LDIF and apply writes two entries', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('apply1'))
  await editDescription(page, 'applied one')
  await page.goto(`c/demo/entry?dn=${encodeURIComponent(e2eDN('apply2'))}`)
  await editDescription(page, 'applied two')
  await page.getByRole('button', { name: 'Review 2 changes' }).click()
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  await expect(dialog).toContainText(`dn: ${e2eDN('apply1')}`)
  await expect(dialog).toContainText('delete: description')
  await expect(dialog).toContainText('description: applied two')
  await dialog.getByRole('button', applyButton).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: /Review \d+ change/ })).toHaveCount(0)
  await page.reload()
  await expect(attrRow(page, 'description')).toContainText('applied two')
  await expect(attrRow(page, 'description').getByLabel('changed')).toHaveCount(0)
})

test('a partial apply keeps only the failed entry, with its error', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('partial1'))
  await editDescription(page, 'partial one')
  await page.goto(`c/demo/entry?dn=${encodeURIComponent(e2eDN('partial2'))}`)
  await editDescription(page, 'partial two')
  // The staged delete of the old description no longer matches: a conflict.
  ldapmodify(
    `dn: ${e2eDN('partial2')}\nchangetype: modify\nreplace: description\ndescription: their edit\n`,
  )
  await page.getByRole('button', { name: 'Review 2 changes' }).click()
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  await dialog.getByRole('button', applyButton).click()
  await expect(dialog.getByRole('alert')).toContainText('The entry changed since you read it.')
  await expect(dialog).toContainText(`dn: ${e2eDN('partial2')}`)
  await expect(dialog.locator('section.border-danger')).toContainText(`dn: ${e2eDN('partial2')}`)
  await expect(dialog).not.toContainText(`dn: ${e2eDN('partial1')}`)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Review 1 change' })).toBeVisible()
  await page.goto(`c/demo/entry?dn=${encodeURIComponent(e2eDN('partial1'))}`)
  await expect(attrRow(page, 'description')).toContainText('partial one')
  await expect(attrRow(page, 'description').getByLabel('changed')).toHaveCount(0)
})

test('an apply in flight freezes the review, posts once, and leaves no undo', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('inflight'))
  await editDescription(page, 'in flight')
  let posts = 0
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/changes/apply', async (route) => {
    posts++
    await held
    await route.continue()
  })
  await page.getByRole('button', { name: 'Review 1 change' }).click()
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  const apply = dialog.getByRole('button', applyButton)
  await apply.click()
  await expect(apply).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Discard all' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Discard this entry' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+Z')
  await apply.click({ force: true })
  await expect(dialog).toContainText('description: in flight')
  release()
  await expect(dialog).toBeHidden()
  expect(posts).toBe(1)
  // The written change is gone from undo as well.
  await blur(page)
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(page.getByRole('button', { name: /Review \d+ change/ })).toHaveCount(0)
  await page.reload()
  await expect(attrRow(page, 'description')).toContainText('in flight')
})

test('prod profile applies only after typing its name', async ({ page }) => {
  await openEntry(page, 'prod-rw', e2eDN('prodrw'))
  // The server refuses a bypassed UI without the exact name.
  expect(await applyDirect(page, 'prod-rw')).toEqual({
    status: 409,
    code: 'confirmation_required',
  })
  expect(await applyDirect(page, 'prod-rw', 'prod-r')).toEqual({
    status: 409,
    code: 'confirmation_required',
  })
  await editDescription(page, 'prod edit')
  await page.getByRole('button', { name: 'Review 1 change' }).click()
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  const apply = dialog.getByRole('button', applyButton)
  await expect(apply).toBeDisabled()
  await dialog.getByLabel('Type prod-rw to apply').fill('prod-r')
  await expect(apply).toBeDisabled()
  await dialog.getByLabel('Type prod-rw to apply').fill('prod-rw')
  await apply.click()
  await expect(dialog).toBeHidden()
  await page.reload()
  await expect(attrRow(page, 'description')).toContainText('prod edit')
})

test('read-only profile: the server refuses a direct apply', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('button', { name: /^prod-bad\b/ }).click()
  const pw = page.getByRole('dialog').locator('input[type=password]')
  await pw.fill('adminpassword')
  await pw.press('Enter')
  await expect(page).toHaveURL(/\/c\/prod-bad/)
  expect(await applyDirect(page, 'prod-bad')).toEqual({ status: 403, code: 'read_only' })
})

test('a batch too large for sessionStorage stays in the tab, with a warning', async ({ page }) => {
  // Every batch write but an empty one fails, as when a staged photo meets the quota.
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('ldapui:batch:') && value !== '[]')
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      setItem.call(this, key, value)
    }
  })
  await openEntry(page, 'demo', e2eDN('quota'))
  await editDescription(page, 'kept in the tab')
  await page.getByRole('button', { name: 'Review 1 change' }).click()
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  await expect(dialog.getByText('This batch is too large to survive a reload')).toBeVisible()
  await expect(dialog).toContainText('description: kept in the tab')
  expect(await page.evaluate(() => sessionStorage.getItem('ldapui:batch:demo'))).toBe('[]')
})
