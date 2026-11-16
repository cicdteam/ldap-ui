import { expect, test } from '@playwright/test'
import { e2eDN } from './fixture'
import { attrRow, blur, exact, openEntry, pendingBar, reviewButton } from './helpers'

test('the pending bar names the connection; Review applies to it; no header badge', async ({
  page,
}) => {
  await openEntry(page, 'demo', e2eDN('pending'))
  await expect(pendingBar(page)).toHaveCount(0)
  await page.getByRole('button', exact('Edit')).click()
  const desc = attrRow(page, 'description').locator('input').first()
  await desc.fill('pending applied')
  await desc.press('Enter')

  const bar = pendingBar(page)
  await expect(bar).toContainText('1 change in 1 entry staged for demo')
  await expect(bar).toContainText('ldap://127.0.0.1:1390')
  // Between the panes and the status bar, and the header has no Review badge any more.
  const status = page.getByRole('contentinfo', { name: 'Connection status' })
  expect((await bar.boundingBox())!.y + (await bar.boundingBox())!.height).toBeLessThanOrEqual(
    (await status.boundingBox())!.y,
  )
  await expect(page.getByRole('banner').getByRole('button', { name: /Review/ })).toHaveCount(0)

  await reviewButton(page).click()
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  await expect(dialog).toContainText(
    '1 change in 1 entry will be written to demo at ldap://127.0.0.1:1390.',
  )
  await dialog.getByRole('button', exact('Apply to demo')).click()
  await expect(dialog).toBeHidden()
  await expect(bar).toHaveCount(0)
  await page.getByRole('button', exact('Edit')).click()
  await expect(attrRow(page, 'description')).toContainText('pending applied')
  await expect(attrRow(page, 'description').getByLabel('changed')).toHaveCount(0)
})

test('Discard asks first; Mod+Z brings the changes back', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('pendingdrop'))
  await page.getByRole('button', exact('Edit')).click()
  const desc = attrRow(page, 'description').locator('input').first()
  await desc.fill('to drop')
  await desc.press('Enter')
  await attrRow(page, 'mail').locator('input').first().fill('drop@example.org')
  await attrRow(page, 'mail').locator('input').first().press('Enter')
  const bar = pendingBar(page)
  await expect(bar).toContainText('2 changes in 1 entry staged for demo')

  page.once('dialog', (d) => {
    expect(d.message()).toBe('Discard 2 unapplied changes?')
    void d.dismiss()
  })
  await bar.getByRole('button', exact('Discard')).click()
  await expect(bar).toContainText('2 changes in 1 entry')
  page.once('dialog', (d) => void d.accept())
  await bar.getByRole('button', exact('Discard')).click()
  await expect(bar).toHaveCount(0)
  await blur(page)
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(bar).toContainText('2 changes in 1 entry')
})
