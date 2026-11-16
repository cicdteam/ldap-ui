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
  // The bar keeps the text as typed.
  await expect(queryBar(page)).toHaveText('doe')
})

test('text with = runs as an LDAP filter', async ({ page }) => {
  await connect(page, 'demo')
  await queryBar(page).click()
  await page.keyboard.type('uid=jdoe')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/filter=%28uid%3Djdoe%29/)
  await expect(page.getByText('1 entry', { exact: true })).toBeVisible()
  await expect(results(page).getByRole('row', { name: /Doe, John/ })).toBeVisible()
})

test('a pasted DN under the base opens that entry, with no list', async ({ page }) => {
  await connect(page, 'demo')
  const dn = e2eDN('read')
  await queryBar(page).click()
  await page.keyboard.insertText(dn)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`dn=${encodeURIComponent(dn)}$`))
  await expect(page.getByRole('heading', exact('uid=read'))).toBeVisible()
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
