import { e2eDN } from './fixture'
import { attrRow, ldapmodify, openEntry, pendingBar, reviewButton } from './helpers'
import { expect, test } from './test'

// exact: names match as case-insensitive substrings ("Copy LDIF for uid=...").
const editButton = { name: 'Edit', exact: true }
const applyButton = { name: 'Apply to demo', exact: true }

test('a value changed behind our back: conflict, reload, drop stale', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('conflict'))
  await page.getByRole('button', editButton).click()
  const desc = attrRow(page, 'description').locator('input').first()
  await desc.fill('my edit')
  await desc.press('Enter')
  // Out of edit mode values show as text, not as input values.
  await page.getByRole('button', editButton).click()
  ldapmodify(
    `dn: ${e2eDN('conflict')}\nchangetype: modify\nreplace: description\ndescription: their edit\n`,
  )
  await expect(pendingBar(page)).toContainText('1 change in')
  await reviewButton(page).click()
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  await dialog.getByRole('button', applyButton).click()
  await expect(dialog).toContainText('The entry changed since you read it.')
  await page.keyboard.press('Escape')
  // The banner (with its buttons) and the row both say it; only the banner is an alert.
  await expect(attrRow(page, 'description')).toContainText('The entry changed since you read it.')
  await expect(page.getByRole('alert')).toHaveCount(1)
  await page.getByRole('button', { name: 'Reload entry' }).first().click()
  await expect(attrRow(page, 'description')).toContainText('their edit')
  await expect(attrRow(page, 'description').getByLabel('stale')).toBeVisible()
  await page.getByRole('button', { name: 'Drop stale changes' }).click()
  await expect(attrRow(page, 'description').getByLabel('stale')).toHaveCount(0)
})

test('server rejection shows at the field', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('rejected'))
  await page.getByRole('button', editButton).click()
  // mail is IA5String: OpenLDAP rejects non-ASCII (invalidAttributeSyntax),
  // which no client rule catches.
  await attrRow(page, 'mail').getByRole('button', { name: 'Add mail value' }).click()
  const fresh = attrRow(page, 'mail').locator('input').last()
  await fresh.fill('bad-ü@example.org')
  await fresh.press('Enter')
  await expect(pendingBar(page)).toContainText('1 change in')
  await reviewButton(page).click()
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  await dialog.getByRole('button', applyButton).click()
  await expect(dialog).toContainText(/invalid/i)
  await page.keyboard.press('Escape')
  await expect(attrRow(page, 'mail').getByRole('alert')).toContainText(/invalid/i)
  await expect(page.getByRole('alert')).toHaveCount(1)
  // With the row filtered out, the entry banner carries the error instead.
  await page.getByLabel('Filter attributes and values').fill('sn')
  await expect(attrRow(page, 'mail')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByRole('alert')).toContainText(/invalid/i)
})
