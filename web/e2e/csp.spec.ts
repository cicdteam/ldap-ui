import { expect, test, type Page } from '@playwright/test'
import { attrRow, blur, connect, exact } from './helpers'

// The policy the server sends (internal/api/middleware.go).
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"

// A demo person with a jpegPhoto (deploy/demo-ldif/gen.sh).
const PHOTO_PERSON = 'uid=user001,ou=people,dc=example,dc=org'

type Collected = Window & { cspViolations: string[] }

/** The violations this document has reported so far. */
const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as Collected).cspViolations)

test('the CSP blocks nothing: photo, filter completion, palette, staged edit, Review', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as Collected
    w.cspViolations = []
    document.addEventListener('securitypolicyviolation', (e) =>
      w.cspViolations.push(`${e.effectiveDirective} ${e.blockedURI}`),
    )
  })
  await connect(page, 'demo')
  expect(await violations(page)).toEqual([])

  const doc = await page.goto(`c/demo/entry?dn=${encodeURIComponent(PHOTO_PERSON)}`)
  expect(doc?.headers()['content-security-policy']).toBe(CSP)
  const photo = attrRow(page, 'jpegPhoto').locator('img')
  await expect(photo).toBeVisible()
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0)

  // CodeMirror's injected <style> applies: its base theme makes the editor a flex box.
  await expect(page.locator('.cm-editor').first()).toHaveCSS('display', 'flex')
  await page.locator('.cm-content[aria-label="LDAP filter"]').click()
  await page.keyboard.type('(jpegPh')
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('jpegPhoto')
  await page.keyboard.press('Escape')

  await blur(page)
  await page.keyboard.press('ControlOrMeta+K')
  await expect(page.locator('[cmdk-input]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[cmdk-input]')).toHaveCount(0)

  await page.getByRole('button', exact('Edit')).click()
  const mail = attrRow(page, 'mail').locator('input').first()
  await mail.fill('csp@example.org')
  await mail.press('Enter')
  await blur(page)
  await page.keyboard.press('ControlOrMeta+S')
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  await expect(dialog).toContainText('mail: csp@example.org')

  expect(await violations(page)).toEqual([])
})
