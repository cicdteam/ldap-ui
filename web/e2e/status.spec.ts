import { expect, test, type Page } from '@playwright/test'
import { e2eDN } from './fixture'
import { attrRow, connect, openEntry, pendingBar } from './helpers'

const bar = (page: Page) => page.getByRole('contentinfo', { name: 'Connection status' })

test('status bar: address, transport, server type and the keys of the focused pane', async ({
  page,
}) => {
  await openEntry(page, 'demo', e2eDN('read'))
  const status = bar(page)
  await expect(status).toContainText('ldap://127.0.0.1:1390')
  await expect(status).toContainText('not encrypted')
  await expect(status.getByText('LDAP', { exact: true })).toBeVisible()

  await page.getByRole('tree', { name: 'Directory tree' }).focus()
  await expect(status).toContainText('expand')
  await page.locator('#card-heading').focus()
  await expect(status).toContainText('undo')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const desc = attrRow(page, 'description').locator('input').first()
  await desc.focus()
  await expect(status).toContainText('stage value')
  await desc.fill('status bar edit')
  await desc.press('Enter')
  await expect(pendingBar(page)).toContainText('1 change in 1 entry staged for demo')

  // Staged only: discarding leaves the directory as it was.
  await page.keyboard.press('ControlOrMeta+S')
  const review = page.getByRole('dialog', { name: 'Review changes' })
  await review.getByRole('button', { name: 'Discard all' }).click()
  await page.keyboard.press('Escape')
  await expect(pendingBar(page)).toHaveCount(0)
})

test('status bar on Active Directory over ldaps', async ({ page }) => {
  await connect(page, 'ad')
  const status = bar(page)
  await expect(status).toContainText('ldaps://127.0.0.1:1637')
  await expect(status.getByText('TLS', { exact: true })).toBeVisible()
  await expect(status).toContainText('Active Directory')
  await expect(status).not.toContainText('certificate not verified')
})

test('status bar fits the window at compact density', async ({ page }) => {
  await connect(page, 'demo')
  const status = bar(page)
  await expect.poll(async () => (await status.boundingBox())?.height).toBe(24)
  await page.getByRole('button', { name: 'Toggle density', exact: true }).click()
  await expect.poll(async () => (await status.boundingBox())?.height).toBe(22)
  const box = await status.boundingBox()
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await page.getByRole('button', { name: 'Toggle density', exact: true }).click()
})
