import { HUGE_GROUP } from './fixture'
import { attrRow, openEntry, valueItems } from './helpers'
import { expect, test } from './test'

test('huge attribute: 100 values, +1000, filter narrows, new filter resets', async ({ page }) => {
  await openEntry(page, 'demo', HUGE_GROUP)
  await expect(valueItems(page, 'member')).toHaveCount(100)
  await attrRow(page, 'member').getByRole('button', { name: 'Show 1000 more (5000 total)' }).click()
  await expect(valueItems(page, 'member')).toHaveCount(1100)
  const filter = page.getByLabel('Filter attributes and values')
  await filter.fill('user4999,')
  await expect(valueItems(page, 'member')).toHaveCount(1)
  await filter.fill('user1')
  await expect(valueItems(page, 'member')).toHaveCount(100)
})

test('a button tip shows right away on hover and on keyboard focus', async ({ page }) => {
  await openEntry(page, 'demo', 'uid=user001,ou=people,dc=example,dc=org')
  const more = page.getByRole('button', { name: 'More', exact: true })
  // The quick tip replaces the browser's slow title.
  await expect(more).not.toHaveAttribute('title')
  await more.hover()
  const tip = page.getByRole('tooltip')
  await expect(tip).toContainText('More: raw values, reload', { timeout: 1000 })
  await expect(more).toHaveAttribute('aria-describedby', (await tip.getAttribute('id'))!)
  await page.mouse.move(0, 0)
  await expect(tip).toHaveCount(0)
  // Keyboard focus shows it too; a click hides it.
  await more.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(tip).toBeVisible({ timeout: 1000 })
  await page.keyboard.press('Escape')
})
