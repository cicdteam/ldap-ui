import { BASE, e2eDN } from './fixture'
import { blur, connect, exact, palette, queryBar, results } from './helpers'
import { expect, test } from './test'

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

test('the keyboard alone: /, a name, Enter, Down into the list, Esc back to the card', async ({
  page,
}) => {
  await connect(page, 'demo')
  await blur(page)
  await page.keyboard.press('/')
  await page.keyboard.type('doe')
  await page.keyboard.press('Enter')
  const rows = results(page).getByRole('row')
  await expect(rows.nth(2)).toBeVisible()
  const dns = await Promise.all([1, 2].map(async (i) => (await rows.nth(i).getAttribute('title'))!))
  const at = (dn: string) => expect.poll(() => new URL(page.url()).searchParams.get('dn')).toBe(dn)
  const heading = page.locator('#card-heading')
  // The card is headed by the name the row shows.
  const name = async (i: number) => (await rows.nth(i).getByRole('gridcell').first().textContent())!

  // Down leaves the bar for the list and opens its first row; the next Down moves the card.
  await page.keyboard.press('ArrowDown')
  await expect(results(page)).toBeFocused()
  await at(dns[0])
  await expect(heading).toHaveText(await name(1))
  await page.keyboard.press('ArrowDown')
  await at(dns[1])
  await expect(heading).toHaveText(await name(2))
  await page.keyboard.press('Escape')
  await expect(results(page)).toHaveCount(0)
  await expect(heading).toBeFocused()
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

test('palette Run and Format, editor Shift+Alt+F, invalid filter notice', async ({ page }) => {
  await connect(page, 'demo')
  const editor = queryBar(page)
  const long =
    '(&(cn=huge)(objectClass=groupOfNames)(description=some long description value here))'
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(long)
  await palette(page, 'Format the filter')
  await page.keyboard.press('Enter')
  await expect(editor.locator('.cm-line')).toHaveCount(5)
  let searches = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/search')) searches++
  })
  await palette(page, 'Run search')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/filter=/)
  // The search request follows the URL change.
  await expect.poll(() => searches).toBeGreaterThan(0)
  // Unfocused, the bar shows the first of the five lines: click there.
  await editor.click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('(cn=')
  await page.keyboard.press('Shift+Alt+KeyF')
  await expect(page.getByText(/Fix the filter first/)).toBeVisible()
})

test('Clear empties the bar; the builder starts from the text and writes it', async ({ page }) => {
  await connect(page, 'demo')
  const bar = queryBar(page)
  const clear = page.getByRole('button', { name: 'Clear the search', exact: true })
  const builder = page.getByRole('button', { name: 'Filter builder', exact: true })
  const attr = page.getByLabel('Attribute', { exact: true })
  await expect(clear).toHaveCount(0)
  await bar.click()
  await page.keyboard.type('(cn=x)')
  await builder.click()
  await expect(attr).toHaveValue('cn')
  await page.getByLabel('Value', { exact: true }).fill('y')
  await expect(bar).toHaveText('(cn=y)')
  await page.keyboard.press('Escape')
  await clear.click()
  // An empty bar shows only its placeholder.
  await expect(bar.locator('.cm-placeholder')).toBeVisible()
  await expect(bar).toBeFocused()
  await expect(clear).toHaveCount(0)
  await builder.click()
  await expect(attr).toHaveCount(0)
})
