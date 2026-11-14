import { expect, test } from '@playwright/test'
import { HUGE_GROUP } from './fixture'
import { attrRow, blur, connect, openEntry, valueItems } from './helpers'

test('stored password rejected: field, hint, focus, typed password connects', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('button', { name: /^prod-bad\b/ }).click()
  const dialog = page.getByRole('dialog')
  const pw = dialog.locator('input[type=password]')
  await expect(pw).toBeVisible()
  await expect(pw).toBeFocused()
  await expect(
    dialog.getByText('The stored password did not work; enter one to try.'),
  ).toBeVisible()
  await expect(pw).toHaveAttribute('autocomplete', 'current-password')
  const user = dialog.locator('input[autocomplete=username]')
  await expect(user).toHaveValue('cn=admin,dc=example,dc=org')
  await expect(user).toHaveAttribute('tabindex', '-1')
  await pw.fill('wrong2')
  // Enter during a pending connect is ignored: let the typed attempt settle.
  const rejected = page.waitForResponse((r) => r.url().endsWith('/api/connect'))
  await pw.press('Enter')
  expect((await rejected).status()).toBe(401)
  await expect(dialog.getByRole('button', { name: 'Connect' })).toBeEnabled()
  await expect(
    dialog.getByText('The stored password did not work; enter one to try.'),
  ).toBeVisible()
  await expect(pw).toHaveAttribute('aria-describedby', /.+/)
  await pw.fill('adminpassword')
  await pw.press('Enter')
  await expect(page).toHaveURL(/\/c\/prod-bad/)
})

test('prompt-only profile shows no stored-password hint', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('button', { name: /^demo-pw\b/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[type=password]').fill('nope')
  await dialog.locator('input[type=password]').press('Enter')
  await expect(dialog.getByText(/Invalid Credentials/)).toBeVisible()
  await expect(dialog.getByText(/stored password/)).toHaveCount(0)
})

test('badges and color come with info even when /profiles fails', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('button', { name: /^prod-bad\b/ }).click()
  const pw = page.getByRole('dialog').locator('input[type=password]')
  await pw.fill('adminpassword')
  await pw.press('Enter')
  await expect(page).toHaveURL(/\/c\/prod-bad/)
  await page.route('**/api/profiles', (r) => r.abort())
  await page.goto('c/prod-bad')
  const header = page.locator('header')
  await expect(header.getByText('PROD', { exact: true })).toBeVisible()
  await expect(header.getByText('READ-ONLY', { exact: true })).toBeVisible()
  await expect(header.locator('a span').first()).toHaveCSS('background-color', 'rgb(221, 51, 51)')
})

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

test('palette Run and Format, editor Shift+Alt+F, invalid filter notice', async ({ page }) => {
  await connect(page, 'demo')
  const editor = page.locator('.cm-content[aria-label="LDAP filter"]')
  const long =
    '(&(cn=huge)(objectClass=groupOfNames)(description=some long description value here))'
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(long)
  const palette = async (label: string) => {
    await blur(page)
    await page.keyboard.press('ControlOrMeta+K')
    await page.locator('[cmdk-input]').fill(label)
    await page.keyboard.press('Enter')
  }
  await palette('Format the filter')
  await expect(editor.locator('.cm-line')).toHaveCount(5)
  let searches = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/search')) searches++
  })
  await palette('Run search')
  await expect(page).toHaveURL(/filter=/)
  // The search request follows the URL change.
  await expect.poll(() => searches).toBeGreaterThan(0)
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('(cn=')
  await page.keyboard.press('Shift+Alt+KeyF')
  await expect(page.getByText(/Fix the filter first/)).toBeVisible()
})

test('Clear results drops the search from the URL and brings back the examples', async ({
  page,
}) => {
  await connect(page, 'demo')
  const editor = page.locator('.cm-content[aria-label="LDAP filter"]')
  await editor.click()
  await page.keyboard.type('(uid=jdoe)')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page).toHaveURL(/filter=/)
  await page.getByRole('button', { name: 'Clear results', exact: true }).click()
  await expect(page).not.toHaveURL(/filter=/)
  await expect(page.getByText(/Type a filter and press Run/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear results', exact: true })).toHaveCount(0)
})

test('Clear filter empties the editor and the builder, then hides', async ({ page }) => {
  await connect(page, 'demo')
  const editor = page.locator('.cm-content[aria-label="LDAP filter"]')
  const clear = page.getByRole('button', { name: 'Clear filter', exact: true })
  await expect(clear).toHaveCount(0)
  await editor.click()
  await page.keyboard.type('(uid=jdoe)')
  await clear.click()
  // An empty editor shows only its placeholder.
  await expect(editor.locator('.cm-placeholder')).toBeVisible()
  await expect(editor).toBeFocused()
  await expect(clear).toHaveCount(0)
  await page.keyboard.type('(cn=x)')
  await page.getByRole('radio', { name: 'builder', exact: true }).click()
  await clear.click()
  await page.getByRole('radio', { name: 'text', exact: true }).click()
  await expect(editor.locator('.cm-placeholder')).toBeVisible()
})

test('smoke: tree, search results, Cmd+K jump, LDIF tab', async ({ page }) => {
  await connect(page, 'demo')
  await expect(page.getByRole('treeitem').first()).toBeVisible()
  await page.keyboard.press('ControlOrMeta+K')
  await page.locator('[cmdk-input]').fill('devs')
  await page.locator('[cmdk-item]', { hasText: 'devs' }).first().click()
  await expect(page).toHaveURL(/dn=cn%3Ddevs/)
  await page.getByRole('tab', { name: 'LDIF' }).click()
  await expect(page.getByText('dn: cn=devs,ou=groups,dc=example,dc=org')).toBeVisible()
})

test('compact density tightens the inspector rows, not only the tree', async ({ page }) => {
  await openEntry(page, 'demo', 'uid=user001,ou=people,dc=example,dc=org')
  const row = attrRow(page, 'cn')
  const height = async () => (await row.boundingBox())?.height ?? 0
  const comfortable = await height()
  await page.getByRole('button', { name: 'Toggle density', exact: true }).click()
  await expect.poll(height).toBeLessThan(comfortable)
  // Icon buttons follow the row height too.
  const button = page.getByRole('button', { name: 'Raw values', exact: true })
  await expect.poll(async () => (await button.boundingBox())?.height).toBe(22)
  // The search panel's controls shrink too.
  await expect
    .poll(
      async () =>
        (await page.getByRole('button', { name: 'Run', exact: true }).boundingBox())?.height,
    )
    .toBe(26)
  await page.getByRole('button', { name: 'Toggle density', exact: true }).click()
})

test('the page does not bounce and fits the window; panels scroll on their own', async ({
  page,
}) => {
  await openEntry(page, 'demo', 'uid=user001,ou=people,dc=example,dc=org')
  const root = await page.evaluate(() =>
    ['html', 'body'].map((s) => {
      const st = getComputedStyle(document.querySelector(s)!)
      return `${st.overflow} ${st.overscrollBehavior}`
    }),
  )
  expect(root).toEqual(['visible none', 'visible none'])
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBe(
    page.viewportSize()!.height,
  )
})

test('the connections page scrolls on its own when it is taller than the window', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 300 })
  await page.goto('./')
  const view = page.locator('main').locator('..')
  await expect.poll(() => view.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true)
  await view.evaluate((e) => e.scrollTo(0, e.scrollHeight))
  await expect(page.getByRole('button', { name: /^prod-rw(?![\w-])/ })).toBeInViewport()
})

test('a button tip shows right away on hover and on keyboard focus', async ({ page }) => {
  await openEntry(page, 'demo', 'uid=user001,ou=people,dc=example,dc=org')
  const raw = page.getByRole('button', { name: 'Raw values', exact: true })
  // The quick tip replaces the browser's slow title.
  await expect(raw).not.toHaveAttribute('title')
  await raw.hover()
  const tip = page.getByRole('tooltip')
  await expect(tip).toContainText('Show values as stored', { timeout: 1000 })
  await expect(raw).toHaveAttribute('aria-describedby', (await tip.getAttribute('id'))!)
  await page.mouse.move(0, 0)
  await expect(tip).toHaveCount(0)
  // Keyboard focus shows it too; a click hides it.
  await raw.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(tip).toBeVisible({ timeout: 1000 })
  await page.keyboard.press('Escape')
})
