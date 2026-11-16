import { expect, test, type Page } from '@playwright/test'
import { BASE, e2eDN } from './fixture'
import { connect, exact, queryBar } from './helpers'

const results = (page: Page) => page.getByRole('grid', exact('Search results'))

test('plain text runs a name search', async ({ page }) => {
  await connect(page, 'demo')
  await queryBar(page).click()
  await page.keyboard.type('doe')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/filter=%28%7C%28cn%3D\*doe\*%29/)
  await expect(results(page).getByRole('row', { name: /Jane Doe/ })).toBeVisible()
  await expect(results(page).getByRole('row', { name: /Doe, John/ })).toBeVisible()
  // The bar keeps the text as typed, also when the columns change and after a reload.
  await expect(queryBar(page)).toHaveText('doe')
  await page.getByRole('button', exact('Columns')).click()
  const add = page.getByRole('combobox', exact('Add a column'))
  await add.fill('description')
  await add.press('Enter')
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/attrs=uid%2Cmail%2Cdescription/)
  await expect(queryBar(page)).toHaveText('doe')
  await page.reload()
  await expect(queryBar(page)).toHaveText('doe')
})

test('text with = runs as an LDAP filter', async ({ page }) => {
  await connect(page, 'demo')
  await queryBar(page).click()
  await page.keyboard.type('uid=jdoe')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/filter=%28uid%3Djdoe%29/)
  // The demo's cn=Doe\, John and the e2e uid=jdoe.
  await expect(page.getByText('2 entries', { exact: true })).toBeVisible()
  await expect(results(page).getByRole('row', { name: /Doe, John/ })).toBeVisible()
})

test('a pasted DN under the base opens that entry, with no list', async ({ page }) => {
  await connect(page, 'demo')
  const dn = e2eDN('read')
  await queryBar(page).click()
  await page.keyboard.insertText(dn)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`dn=${encodeURIComponent(dn)}$`))
  await expect(page.getByRole('heading', exact('E2E read'))).toBeVisible()
  await expect(results(page)).toHaveCount(0)
  // The same text under another base is a filter.
  await queryBar(page).click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText(dn.replace(BASE, 'dc=other,dc=net'))
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/filter=/)
})

test('/ focuses the bar from the tree', async ({ page }) => {
  await connect(page, 'demo')
  await page.getByRole('treeitem', exact(BASE)).click()
  await expect(page.getByRole('tree')).toBeFocused()
  await page.keyboard.press('/')
  await expect(queryBar(page)).toBeFocused()
  // The key focuses, it does not type: the bar shows its placeholder.
  await expect(queryBar(page).locator('.cm-placeholder')).toBeVisible()
})

test('Recent and saved searches: save the current search, run it again', async ({ page }) => {
  await connect(page, 'demo')
  await queryBar(page).click()
  await page.keyboard.type('doe')
  await page.keyboard.press('Enter')
  await expect(results(page).getByRole('row', { name: /Jane Doe/ })).toBeVisible()

  const open = () => page.getByRole('button', exact('Recent and saved searches')).click()
  const popover = page.getByRole('dialog')
  await open()
  // Recent shows the name as typed, not its filter.
  await expect(popover.getByRole('button', { name: /^doe\s*sub under base DN$/ })).toBeVisible()
  await popover.getByPlaceholder('Name this search').fill('Does')
  await popover.getByRole('button', exact('Save')).click()
  const saved = popover.getByRole('button', { name: /^Does\s*doe\s*sub/ })
  await expect(saved).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', exact('Close the list')).click()
  await expect(results(page)).toHaveCount(0)
  await expect(queryBar(page).locator('.cm-placeholder')).toBeVisible()
  await open()
  await saved.click()
  await expect(results(page).getByRole('row', { name: /Jane Doe/ })).toBeVisible()
  await expect(page).toHaveURL(/filter=%28%7C%28cn%3D\*doe\*%29/)
  await expect(queryBar(page)).toHaveText('doe')
})
