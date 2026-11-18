import { attrRow, connect, exact, palette, queryBar, review } from './helpers'
import { expect, test } from './test'

// A demo person with a jpegPhoto (deploy/demo-ldif/gen.sh).
const PHOTO_PERSON = 'uid=user001,ou=people,dc=example,dc=org'

// The policy itself is the server's to test; here the app runs under it, and the fixture in
// test.ts fails the test on any violation.
test('the CSP blocks nothing: photo, filter completion, palette, staged edit, Review', async ({
  page,
}) => {
  await connect(page, 'demo')
  const doc = await page.goto(`c/demo/entry?dn=${encodeURIComponent(PHOTO_PERSON)}`)
  expect(doc?.headers()).toHaveProperty('content-security-policy')
  const photo = attrRow(page, 'jpegPhoto').locator('img')
  await expect(photo).toBeVisible()
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0)

  // CodeMirror's injected <style> applies: its base theme makes the editor a flex box.
  await expect(page.locator('.cm-editor').first()).toHaveCSS('display', 'flex')
  await queryBar(page).click()
  await page.keyboard.type('(jpegPh')
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('jpegPhoto')
  await page.keyboard.press('Escape')

  const input = await palette(page)
  await page.keyboard.press('Escape')
  await expect(input).toHaveCount(0)

  await page.getByRole('button', exact('Edit')).click()
  const mail = attrRow(page, 'mail').locator('input').first()
  await mail.fill('csp@example.org')
  await mail.press('Enter')
  await expect(await review(page)).toContainText('mail: csp@example.org')
})
