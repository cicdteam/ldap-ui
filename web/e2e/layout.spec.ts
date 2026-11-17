import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { E2E_OU, e2eDN } from './fixture'
import { attrRow, blur, connect, exact, openEntry, queryBar } from './helpers'

const results = (page: Page) => page.getByRole('grid', exact('Search results'))
// react-resizable-panels marks every pane with data-panel; the card is the last one.
const panes = (page: Page) => page.locator('[data-panel]')
const close = (page: Page) => page.getByRole('button', exact('Close the list'))
const editButton = (page: Page) => page.getByRole('button', exact('Edit'))
const DN = e2eDN('layout')

async function search(page: Page, text: string) {
  await queryBar(page).click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText(text)
  await page.keyboard.press('Enter')
  await expect(results(page).getByRole('row').nth(1)).toBeVisible()
  await expect(panes(page)).toHaveCount(3)
}

/** Back to tree and card, with the entry, its Edit mode and its staged change still there. */
async function expectClosed(page: Page) {
  await expect(panes(page)).toHaveCount(2)
  await expect(results(page)).toHaveCount(0)
  // The entry view, with the dn and no search left in the URL.
  await expect(page).toHaveURL(new RegExp(`/c/demo/entry\\?dn=${encodeURIComponent(DN)}$`))
  // Focus moves to the card's heading, not to the page.
  await expect(page.getByRole('heading', exact('E2E layout'))).toBeFocused()
  await expect(editButton(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(attrRow(page, 'description').getByLabel('changed')).toHaveCount(1)
}

test('a connection opens with the tree and the card only', async ({ page }) => {
  await connect(page, 'demo')
  await expect(panes(page)).toHaveCount(2)
  await expect(results(page)).toHaveCount(0)
  await expect(page.getByText('Select an entry in the tree, or search above')).toBeVisible()
})

test('a search opens the list; X and Esc close it, keeping the entry and staged changes', async ({
  page,
}) => {
  await openEntry(page, 'demo', DN)
  await expect(panes(page)).toHaveCount(2)
  await editButton(page).click()
  const desc = attrRow(page, 'description').locator('input').first()
  await desc.fill('staged while a list opens')
  await desc.press('Enter')
  await expect(attrRow(page, 'description').getByLabel('changed')).toHaveCount(1)

  await search(page, '(uid=layout)')
  await close(page).hover()
  await expect(page.getByRole('tooltip')).toHaveText('Close the list (Esc)')
  await close(page).click()
  await expectClosed(page)

  await search(page, '(uid=layout)')
  await results(page).getByRole('row').nth(1).click()
  await expect(results(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expectClosed(page)
})

test('Up and Down in the list move the card', async ({ page }) => {
  await connect(page, 'demo')
  await search(page, '(|(uid=read)(uid=edit)(uid=layout))')
  const rows = results(page).getByRole('row')
  await expect(rows).toHaveCount(4)
  const dns = await Promise.all([1, 2].map(async (i) => (await rows.nth(i).getAttribute('title'))!))
  // The card is headed by the entry's name: the fixture's cn, E2E <uid>.
  const heading = (dn: string) =>
    page.getByRole('heading', exact(dn.split(',')[0].replace('uid=', 'E2E ')))
  await rows.nth(1).click()
  await expect(heading(dns[0])).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(page).toHaveURL(new RegExp(`dn=${encodeURIComponent(dns[1])}`))
  await expect(heading(dns[1])).toBeVisible()
  await page.keyboard.press('ArrowUp')
  await expect(page).toHaveURL(new RegExp(`dn=${encodeURIComponent(dns[0])}`))
  await expect(heading(dns[0])).toBeVisible()
})

test('at 1440x900 the card is at least 1100 px wide with no list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openEntry(page, 'demo', DN)
  await expect(panes(page)).toHaveCount(2)
  const card = (await panes(page).last().boundingBox())!
  expect(card.width).toBeGreaterThanOrEqual(1100)
})

test('the layouts with and without the list keep their own sizes, across a reload', async ({
  page,
}) => {
  await openEntry(page, 'demo', DN)
  const width = async (i: number) => (await panes(page).nth(i).boundingBox())!.width
  const near = (i: number, want: number) =>
    expect.poll(async () => Math.abs((await width(i)) - want)).toBeLessThan(2)
  // Each ArrowRight on a separator moves it 5% to the right.
  const widen = async (separator: number) => {
    await page.getByRole('separator').nth(separator).focus()
    await page.keyboard.press('ArrowRight')
  }
  const tree = await width(0)
  await widen(0)
  await expect.poll(() => width(0)).toBeGreaterThan(tree + 50)
  const tree2 = await width(0)

  await search(page, '(uid=layout)')
  const list = await width(1)
  await widen(1)
  await expect.poll(() => width(1)).toBeGreaterThan(list + 50)
  const list3 = await width(1)
  await page.reload()
  await expect(panes(page)).toHaveCount(3)
  await near(1, list3)

  await close(page).click()
  await expect(panes(page)).toHaveCount(2)
  await near(0, tree2)
})

test('Columns and Export open from the list; Esc in them leaves the list open', async ({
  page,
}) => {
  await connect(page, 'demo')
  await search(page, '(uid=layout)')
  await page.getByRole('button', exact('Columns')).click()
  const add = page.getByRole('combobox', exact('Add a column'))
  await add.fill('description')
  await add.press('Enter')
  // Closing the popover runs the search with the picked columns.
  await page.keyboard.press('Escape')
  await expect(add).toHaveCount(0)
  await expect(results(page).getByRole('columnheader')).toHaveText([
    'Name',
    'uid',
    'mail',
    'description',
  ])
  await expect(page).toHaveURL(/attrs=uid%2Cmail%2Cdescription/)
  await expect(panes(page)).toHaveCount(3)

  await page.getByRole('button', exact('Export')).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: /^CSV\b/ }).click()
  expect((await download).suggestedFilename()).toBe('demo-search.csv')

  // LDIF holds the DN and the picked columns, not the cn the Name column asked for.
  await page.getByRole('button', exact('Export')).click()
  const ldif = page.waitForEvent('download')
  await page.getByRole('button', { name: /^LDIF\b/ }).click()
  const text = readFileSync((await (await ldif).path())!, 'utf8')
  expect(text).toContain(`dn: ${DN}`)
  expect(text).toContain('description: ')
  expect(text).not.toMatch(/^(cn|displayName):/m)
})

test('with no entry open, closing the list focuses the tree', async ({ page }) => {
  await connect(page, 'demo')
  await search(page, '(uid=layout)')
  await results(page).focus()
  await page.keyboard.press('Escape')
  await expect(panes(page)).toHaveCount(2)
  await expect(page.getByRole('tree')).toBeFocused()
  await expect(page).toHaveURL(/\/c\/demo\/entry$/)
})

test('List children in the palette lists the entry one level down', async ({ page }) => {
  await openEntry(page, 'demo', E2E_OU)
  await blur(page)
  await page.keyboard.press('ControlOrMeta+K')
  await page.locator('[cmdk-input]').fill('List children of the current entry')
  await page.keyboard.press('Enter')
  await expect(panes(page)).toHaveCount(3)
  await expect(results(page).getByRole('row', { name: /E2E layout/ })).toBeVisible()
  const params = new URL(page.url()).searchParams
  expect([params.get('scope'), params.get('base'), params.get('filter')]).toEqual([
    'one',
    E2E_OU,
    '(objectClass=*)',
  ])
  // The bar keeps its own base and scope: a name typed next searches the whole base.
  await expect(queryBar(page).locator('.cm-placeholder')).toBeVisible()
  await queryBar(page).click()
  await page.keyboard.type('doe')
  await page.keyboard.press('Enter')
  await expect(results(page).getByRole('row', { name: /Doe, John/ })).toBeVisible()
  const next = new URL(page.url()).searchParams
  expect([next.get('scope'), next.get('base')]).toEqual(['sub', null])
})
