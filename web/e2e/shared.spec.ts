import { connect, profileButton } from './helpers'
import { expect, test } from './test'

// demo binds with its configured password (deploy/e2e/connections.yaml), so
// one connection in the server serves every browser, outside any session.
test('a shared profile serves another browser without connecting', async ({ page, browser }) => {
  await connect(page, 'demo')
  const cookies = (await page.context().cookies()).map((c) => c.name)
  expect(cookies).not.toContain('ldaplens_session')

  const other = await browser.newContext()
  try {
    const page2 = await other.newPage()
    await page2.goto('./')
    const demo = profileButton(page2, 'demo')
    await expect(demo).toContainText('CONNECTED')
    await demo.click()
    await expect(page2.getByRole('treeitem', { name: /^ou=people/ })).toBeVisible()

    // One browser's disconnect leaves the connection to the others.
    await page2.getByRole('button', { name: 'Disconnect' }).click()
    await expect(page2).toHaveURL(/\/ldap\/?$/)
    await page.reload()
    await expect(page.getByRole('treeitem', { name: /^ou=people/ })).toBeVisible()
  } finally {
    await other.close()
  }
})
