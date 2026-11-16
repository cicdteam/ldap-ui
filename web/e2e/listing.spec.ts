import { expect, test, type Page } from '@playwright/test'
import { BASE } from './fixture'
import { connect, exact, openEntry } from './helpers'

const count = (page: Page) => page.getByText(/^\d+ entr(y|ies)\b/)
const search = (filter: string, scope: string, base = '') =>
  `search?${new URLSearchParams({ filter, scope, ...(base && { base }) })}`

// ou=people holds the 250 demo people, more than one 200-row tree page.
test('a container past one tree page ends with More entries, which lists it', async ({ page }) => {
  await openEntry(page, 'demo', `uid=user001,ou=people,${BASE}`)
  const tree = page.getByRole('tree')
  const more = page.getByRole('treeitem', { name: /^More entries/ })
  // The tree is virtual: the row exists once scrolled to.
  await expect(async () => {
    await tree.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect(more).toBeVisible({ timeout: 500 })
  }).toPass()
  await more.click()
  await expect(count(page)).toHaveText('250 entries')
  await expect(page.getByRole('button', exact('Load more'))).toHaveCount(0)
})

// OU=Bulk in the AD demo (deploy/demo-ldif/ad-demo.ldif) holds 1600 users.
test('Load more runs the search again with a bigger limit', async ({ page }) => {
  await connect(page, 'ad')
  await page.goto(
    `c/ad/${search('(objectClass=user)', 'one', 'OU=Bulk,OU=Demo,DC=corp,DC=example,DC=test')}`,
  )
  const more = page.getByRole('button', exact('Load more'))
  await expect(count(page)).toHaveText('500 entries, more on the server')
  await more.click()
  await expect(count(page)).toHaveText('1000 entries, more on the server')
  await more.click()
  await expect(count(page)).toHaveText('1600 entries')
  await expect(more).toHaveCount(0)
})

// No fixture matches 5000 entries, so the server's answer is stubbed.
test('Load more stops at 5,000 and says to refine the search', async ({ page }) => {
  const limits: number[] = []
  await page.route('**/api/c/demo/search', (route) => {
    const body = route.request().postDataJSON() as { filter: string; sizeLimit: number }
    if (body.filter !== '(uid=capped)') return route.fallback()
    limits.push(body.sizeLimit)
    return route.fulfill({ json: { entries: [{ dn: `uid=capped,${BASE}` }], more: true } })
  })
  await connect(page, 'demo')
  await page.goto(`c/demo/${search('(uid=capped)', 'sub')}`)
  const more = page.getByRole('button', exact('Load more'))
  await expect.poll(() => limits).toEqual([500])
  for (const limit of [1000, 2000, 5000]) {
    await more.click()
    await expect.poll(() => limits.at(-1)).toBe(limit)
  }
  await expect(
    page.getByText('Showing the first 5,000 entries; refine the search to see the rest'),
  ).toBeVisible()
  await expect(more).toHaveCount(0)
  expect(limits).toEqual([500, 1000, 2000, 5000])
})
