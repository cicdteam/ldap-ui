import { BASE } from './fixture'
import { connect, exact } from './helpers'
import { expect, test, type Page } from './test'

// The demo's entries under an OU whose name holds an escaped comma.
const SALES = `ou=Sales\\, EMEA,${BASE}`
const DOE = `cn=Doe\\, John,${SALES}`
const MUELLER = `cn=Jürgen Müller,${SALES}`

const link = (dn: string) => `c/demo/entry?dn=${encodeURIComponent(dn)}`

/** The card shows dn: dn in the URL, the heading, the path as breadcrumbs. */
async function showing(page: Page, dn: string, heading: string, crumbs: string[]): Promise<void> {
  await expect.poll(() => new URL(page.url()).searchParams.get('dn')).toBe(dn)
  await expect(page.locator('#card-heading')).toHaveText(heading)
  await expect(page.getByRole('navigation', exact('DN path')).getByRole('button')).toHaveText(
    crumbs,
  )
}

test('DNs with escaped commas and umlauts open by link, survive a reload, and Back returns', async ({
  page,
}) => {
  await connect(page, 'demo')
  const sales = [BASE, 'ou=Sales, EMEA']
  const doe = () => showing(page, DOE, 'Doe, John', [...sales, 'cn=Doe, John'])
  const mueller = () => showing(page, MUELLER, 'Jürgen Müller', [...sales, 'cn=Jürgen Müller'])

  await page.goto(link(DOE))
  await doe()
  await page.reload()
  await doe()

  await page.goto(link(MUELLER))
  await mueller()
  await page.reload()
  await mueller()

  // A breadcrumb opens the OU in the app; Back returns through it and the earlier link.
  await page.getByRole('navigation', exact('DN path')).getByRole('button').nth(1).click()
  await showing(page, SALES, 'Sales, EMEA', sales)
  await page.goBack()
  await mueller()
  await page.goBack()
  await doe()
})
