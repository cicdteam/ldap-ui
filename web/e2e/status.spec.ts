import { expect, test, type Page } from '@playwright/test'
import { e2eDN } from './fixture'
import { attrRow, connect, openEntry } from './helpers'

const bar = (page: Page) => page.getByRole('contentinfo', { name: 'Connection status' })

test('status bar: address, transport, server type and staged changes', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('read'))
  const status = bar(page)
  await expect(status).toContainText('ldap://127.0.0.1:1390')
  await expect(status).toContainText('not encrypted')
  await expect(status).toContainText('no staged changes')
  await expect(status.getByText('LDAP', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const desc = attrRow(page, 'description').locator('input').first()
  await desc.fill('status bar edit')
  await desc.press('Enter')
  await expect(status).toContainText('1 change')

  // Staged only: discarding leaves the directory as it was.
  await page.keyboard.press('ControlOrMeta+S')
  const review = page.getByRole('dialog', { name: 'Review changes' })
  await review.getByRole('button', { name: 'Discard all' }).click()
  await page.keyboard.press('Escape')
  await expect(status).toContainText('no staged changes')
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
