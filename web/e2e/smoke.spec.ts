import { expect, test } from '@playwright/test'
import { attrRow, connect } from './helpers'

test('connect, find, change, check LDIF, apply', async ({ page }) => {
  await connect(page, 'demo')
  await page.keyboard.press('ControlOrMeta+K')
  await page.locator('[cmdk-input]').fill('smoke')
  await page.locator('[cmdk-item]', { hasText: 'smoke' }).first().click()
  await expect(page).toHaveURL(/dn=uid%3Dsmoke/)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const mail = attrRow(page, 'mail').locator('input').first()
  await mail.fill('smoke-new@example.org')
  await mail.press('Enter')
  await page.keyboard.press('ControlOrMeta+S')
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  await expect(dialog).toContainText('mail: smoke@example.org')
  await expect(dialog).toContainText('mail: smoke-new@example.org')
  await dialog.getByRole('button', { name: 'Apply to demo', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('tab', { name: 'LDIF' }).click()
  await expect(page.getByText('mail: smoke-new@example.org')).toBeVisible()
})
