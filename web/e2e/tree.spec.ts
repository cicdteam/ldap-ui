import { BASE, e2eDN } from './fixture'
import { connect, exact, openEntry, results } from './helpers'
import { expect, test, type Page } from './test'

const AD_BASE = 'DC=corp,DC=example,DC=test'
const rows = (page: Page) => page.getByRole('treeitem')
/** The tree row whose RDN is rdn (its name starts with it). */
const row = (page: Page, rdn: string) =>
  page.getByRole('treeitem', {
    name: new RegExp(`^${rdn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`),
  })
const filterField = (page: Page) => page.getByRole('searchbox', exact('Filter loaded entries'))

test('an account row shows the person name beside its RDN', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('jdoe'))
  const jdoe = row(page, 'uid=jdoe')
  await expect(jdoe).toHaveAttribute('aria-selected', 'true')
  // displayName, not the cn (J. Doe).
  await expect(jdoe.getByText('John Doe', { exact: true })).toBeVisible()
  await expect(filterField(page)).toHaveAttribute('placeholder', 'Filter loaded entries')
})

test('the filter narrows the loaded rows to the matches and their parents', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('jdoe'))
  // A neighbor of uid=jdoe, in view.
  await expect(row(page, 'cn=join-team')).toBeVisible()
  await filterField(page).fill('doe')
  // The demo's cn=Doe\, John under ou=Sales\, EMEA is not loaded, so it is not there.
  await expect(rows(page)).toHaveText([BASE, /^ou=e2e/, /^uid=jane\.doe/, /^uid=jdoe/])
  // A click selects and collapses ou=e2e, which was there only for its matches: as the
  // selected entry it stays, so the tree does not go empty.
  await row(page, 'ou=e2e').click()
  await expect(rows(page)).toHaveText([BASE, /^ou=e2e/])
  await expect(row(page, 'ou=e2e')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tree')).toHaveAttribute('aria-activedescendant', /^tree-/)
  await row(page, 'ou=e2e').click()
  await filterField(page).fill('')
  await expect(row(page, 'cn=join-team')).toBeVisible()
})

test('one click on a container selects and expands it; Left and Right also toggle it', async ({
  page,
}) => {
  await connect(page, 'demo')
  const people = row(page, 'ou=people')
  const user001 = row(page, 'uid=user001')
  await expect(people).toHaveAttribute('aria-expanded', 'false')
  await people.click()
  await expect(people).toHaveAttribute('aria-expanded', 'true')
  await expect(people).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(new RegExp(`dn=${encodeURIComponent(`ou=people,${BASE}`)}`))
  await expect(user001.getByText('User 001', { exact: true })).toBeVisible()
  await expect(page.getByRole('tree')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(people).toHaveAttribute('aria-expanded', 'false')
  await expect(user001).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(people).toHaveAttribute('aria-expanded', 'true')
  // A second click collapses it again.
  await people.click()
  await expect(people).toHaveAttribute('aria-expanded', 'false')
})

test('collapsing a parent of the selected entry marks the parent, the card stays', async ({
  page,
}) => {
  await openEntry(page, 'demo', e2eDN('jdoe'))
  const e2e = row(page, 'ou=e2e')
  await expect(row(page, 'uid=jdoe')).toHaveAttribute('aria-selected', 'true')
  // The chevron only toggles.
  await e2e.getByTitle('Collapse', { exact: true }).click()
  await expect(e2e).toHaveAttribute('aria-expanded', 'false')
  await expect(e2e).toHaveAttribute('aria-selected', 'true')
  const id = await e2e.getAttribute('id')
  await expect(page.getByRole('tree')).toHaveAttribute('aria-activedescendant', id!)
  await expect(page).toHaveURL(new RegExp(`dn=${encodeURIComponent(e2eDN('jdoe'))}`))
  await e2e.getByTitle('Expand', { exact: true }).click()
  await expect(row(page, 'uid=jdoe')).toHaveAttribute('aria-selected', 'true')
  await expect(e2e).toHaveAttribute('aria-selected', 'false')
})

test('a container row lists its children from its List children icon', async ({ page }) => {
  await connect(page, 'demo')
  const people = row(page, 'ou=people')
  const icon = people.getByTitle('List children of ou=people in the list pane (Shift+Enter)', {
    exact: true,
  })
  await expect(icon).toBeHidden()
  await people.hover()
  await icon.click()
  await expect(page.getByText('250 entries', { exact: true })).toBeVisible()
  // The icon lists; it does not expand the row.
  await expect(people).toHaveAttribute('aria-expanded', 'false')
  const params = new URL(page.url()).searchParams
  expect([params.get('scope'), params.get('base')]).toEqual(['one', `ou=people,${BASE}`])
  // The focused row shows it too, for the keyboard.
  await page.mouse.move(0, 0)
  await page.getByRole('tree').focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await expect(row(page, 'ou=e2e').getByTitle(/^List children of ou=e2e/)).toBeVisible()
  await expect(icon).toBeHidden()
  // Shift+Enter does what the icon does.
  await page.keyboard.press('Shift+Enter')
  await expect(results(page)).toContainText('E2E layout')
  expect(new URL(page.url()).searchParams.get('base')).toBe(`ou=e2e,${BASE}`)
  // Leaves have none.
  await openEntry(page, 'demo', e2eDN('jdoe'))
  await row(page, 'uid=jdoe').hover()
  await expect(row(page, 'uid=jdoe').getByTitle(/^List children/)).toHaveCount(0)
})

test('in a narrow tree an account row fits: the name gives way first, then the RDN', async ({
  page,
}) => {
  // The tree takes 18% of 600 px.
  await page.setViewportSize({ width: 600, height: 900 })
  await openEntry(page, 'demo', e2eDN('jdoe'))
  const jdoe = row(page, 'uid=jdoe')
  await expect(jdoe).toBeVisible()
  const widths = await jdoe.evaluate((el) => {
    const label = el.querySelector('[title]')!
    const hint = [...el.querySelectorAll('span')].find((s) => s.textContent === 'John Doe')!
    return {
      overflow: el.scrollWidth - el.clientWidth,
      labelCut: label.scrollWidth > label.clientWidth,
      hint: hint.clientWidth,
    }
  })
  expect(widths.overflow).toBe(0)
  // The RDN is cut only once the name has no room left.
  if (widths.labelCut) expect(widths.hint).toBe(0)
})

// OU=Bulk in the AD demo (deploy/demo-ldif/ad-demo.ldif) holds 1600 users: one tree page.
test('1,600 children load in one page, render as a window and filter', async ({ page }) => {
  await openEntry(page, 'ad', `OU=Bulk,OU=Demo,${AD_BASE}`)
  const bulk = row(page, 'OU=Bulk')
  await bulk.click()
  await expect(bulk).toHaveAttribute('aria-expanded', 'true')
  await expect(row(page, 'CN=Bulk 0001')).toBeVisible()
  // Virtual: the page holds the rows in view, not 1,600.
  expect(await rows(page).count()).toBeLessThan(100)
  await page.getByRole('tree').evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await expect(row(page, 'CN=Bulk 1600')).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /^More entries/ })).toHaveCount(0)
  // The filter reaches loaded rows outside the window.
  await page.getByRole('tree').evaluate((el) => el.scrollTo(0, 0))
  await filterField(page).fill('bulk 1599')
  await expect(rows(page)).toHaveText([AD_BASE, /^OU=Demo/, /^OU=Bulk/, /^CN=Bulk 1599/])
})
