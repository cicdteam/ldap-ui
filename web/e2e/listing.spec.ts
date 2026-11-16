import { expect, test, type Page, type Route } from '@playwright/test'
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

/**
 * Stubs the demo searches with filter: answer turns each sizeLimit into the response. Returns the
 * limits asked for, in order. Other searches (the tree) reach the server.
 */
async function stub(
  page: Page,
  filter: string,
  answer: (
    limit: number,
  ) => Parameters<Route['fulfill']>[0] | Promise<Parameters<Route['fulfill']>[0]>,
): Promise<number[]> {
  const limits: number[] = []
  await page.route('**/api/c/demo/search', async (route) => {
    const body = route.request().postDataJSON() as { filter: string; sizeLimit: number }
    if (body.filter !== filter) return route.fallback()
    limits.push(body.sizeLimit)
    return route.fulfill(await answer(body.sizeLimit))
  })
  return limits
}

/** n entries named uid=<name>1..n. */
const entries = (name: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ dn: `uid=${name}${i + 1},${BASE}` }))

// No fixture matches 5000 entries, so the server's answer is stubbed.
test('Load more stops at 5,000 and says to refine the search', async ({ page }) => {
  const limits = await stub(page, '(uid=capped)', () => ({
    json: { entries: entries('capped', 1), more: true },
  }))
  await connect(page, 'demo')
  await page.goto(`c/demo/${search('(uid=capped)', 'sub')}`)
  const more = page.getByRole('button', exact('Load more'))
  await expect.poll(() => limits).toEqual([500])
  for (const limit of [1000, 2000, 5000]) {
    await more.click()
    await expect.poll(() => limits.at(-1)).toBe(limit)
  }
  await expect(
    page.getByText('Showing the first 5,000 entries; refine the search to see the rest', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(more).toHaveCount(0)
  expect(limits).toEqual([500, 1000, 2000, 5000])
})

test('a failed Load more gives the first rows back; running the search again starts at 500', async ({
  page,
}) => {
  let failures = 1
  const limits = await stub(page, '(uid=flaky)', (limit) =>
    limit === 1000 && failures-- > 0
      ? { status: 500, json: { code: 'internal', message: 'The search failed' } }
      : { json: { entries: entries('flaky', limit / 500), more: true } },
  )
  await connect(page, 'demo')
  // The demo's default columns, so Run below repeats this very search.
  await page.goto(`c/demo/${search('(uid=flaky)', 'sub')}&attrs=uid,mail`)
  const more = page.getByRole('button', exact('Load more'))
  await expect(count(page)).toHaveText('1 entry, more on the server')
  await more.click()
  await expect(page.getByRole('alert')).toContainText('The search failed')
  // The first answer is still cached: going back to it asks the server nothing.
  await page.getByRole('button', exact('Show the first 500')).click()
  await expect(count(page)).toHaveText('1 entry, more on the server')
  await expect(page.getByRole('row', { name: /flaky1/ })).toBeVisible()
  await expect(page.getByText('The search failed')).toHaveCount(0)
  expect(limits).toEqual([500, 1000])
  // Load more works again, and Run starts over at 500.
  await more.click()
  await expect(count(page)).toHaveText('2 entries, more on the server')
  await page.getByRole('button', exact('Run')).click()
  await expect.poll(() => limits).toEqual([500, 1000, 1000, 500])
  await expect(count(page)).toHaveText('1 entry, more on the server')
})

test('the rows stay while more load; Cancel then Load more asks for the same limit', async ({
  page,
}) => {
  let holds = 1
  const limits = await stub(page, '(uid=slow)', async (limit) => {
    // The first 1000 request never gets an answer until it is canceled.
    if (limit === 1000 && holds-- > 0) await new Promise(() => {})
    return { json: { entries: entries('slow', limit / 500), more: limit < 1000 } }
  })
  await connect(page, 'demo')
  await page.goto(`c/demo/${search('(uid=slow)', 'sub')}`)
  const more = page.getByRole('button', exact('Load more'))
  await expect(count(page)).toHaveText('1 entry, more on the server')
  await more.click()
  await expect.poll(() => limits).toEqual([500, 1000])
  await expect(page.getByRole('row', { name: /slow1/ })).toBeVisible()
  await expect(count(page)).toHaveText('1 entry, more on the server')
  await page.getByRole('button', exact('Cancel')).click()
  await more.click()
  await expect(count(page)).toHaveText('2 entries')
  expect(limits).toEqual([500, 1000, 1000])
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})
