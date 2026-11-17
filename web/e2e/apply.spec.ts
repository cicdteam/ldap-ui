import { e2eDN } from './fixture'
import { attrRow, blur, ldapmodify, openEntry, pendingBar, reviewButton } from './helpers'
import { expect, test, type Page } from './test'

// exact: names match as case-insensitive substrings, and breadcrumbs or
// "Copy LDIF for uid=apply1,..." would match too.
const editButton = { name: 'Edit', exact: true }
const applyButton = { name: 'Apply to demo', exact: true }

async function editDescription(page: Page, text: string) {
  await page.getByRole('button', editButton).click()
  const desc = attrRow(page, 'description').locator('input').first()
  await desc.fill(text)
  await desc.press('Enter')
  await page.getByRole('button', editButton).click()
}

test('review shows LDIF and apply writes two entries', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('apply1'))
  await editDescription(page, 'applied one')
  await page.goto(`c/demo/entry?dn=${encodeURIComponent(e2eDN('apply2'))}`)
  await editDescription(page, 'applied two')
  await expect(pendingBar(page)).toContainText('2 changes in 2 entries staged for demo')
  await reviewButton(page).click()
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  await expect(dialog).toContainText(`dn: ${e2eDN('apply1')}`)
  await expect(dialog).toContainText('delete: description')
  await expect(dialog).toContainText('description: applied two')
  await dialog.getByRole('button', applyButton).click()
  await expect(dialog).toBeHidden()
  await expect(pendingBar(page)).toHaveCount(0)
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
  await expect(pendingBar(page)).toContainText('2 changes in 2 entries staged for demo')
  await reviewButton(page).click()
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  await dialog.getByRole('button', applyButton).click()
  await expect(dialog.getByRole('alert')).toContainText('The entry changed since you read it.')
  await expect(dialog).toContainText(`dn: ${e2eDN('partial2')}`)
  await expect(dialog.locator('section.border-danger')).toContainText(`dn: ${e2eDN('partial2')}`)
  await expect(dialog).not.toContainText(`dn: ${e2eDN('partial1')}`)
  await page.keyboard.press('Escape')
  await expect(pendingBar(page)).toContainText('1 change in')
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
  await expect(pendingBar(page)).toContainText('1 change in')
  await reviewButton(page).click()
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
  await expect(pendingBar(page)).toHaveCount(0)
  await page.reload()
  await expect(attrRow(page, 'description')).toContainText('in flight')
})

test('a batch too large for sessionStorage stays in the tab, with a warning', async ({ page }) => {
  // Every batch write but an empty one fails, as when a staged photo meets the quota.
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('ldaplens:batch:') && value !== '[]')
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      setItem.call(this, key, value)
    }
  })
  await openEntry(page, 'demo', e2eDN('quota'))
  await editDescription(page, 'kept in the tab')
  await expect(pendingBar(page)).toContainText('1 change in')
  await reviewButton(page).click()
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  await expect(dialog.getByText('This batch is too large to survive a reload')).toBeVisible()
  await expect(dialog).toContainText('description: kept in the tab')
  expect(await page.evaluate(() => sessionStorage.getItem('ldaplens:batch:demo'))).toBe('[]')
})
