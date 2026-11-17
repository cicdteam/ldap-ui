import { readFileSync } from 'node:fs'
import { CERT, E2E_OU, e2eDN, PHOTO } from './fixture'
import { attrRow, blur, exact, openEntry, pendingBar, review } from './helpers'
import { expect, test, type Locator, type Page } from './test'

const PHOTO_B64 = readFileSync(PHOTO).toString('base64')
const PHOTO_SUMMARY = `jpegPhoto:: (binary, ${readFileSync(PHOTO).length} bytes)`

/** Clicks Download on attr's first value; the saved file's name and bytes. */
async function download(page: Page, attr: string) {
  const saved = page.waitForEvent('download')
  await attrRow(page, attr)
    .getByRole('button', exact(`Download ${attr} value`))
    .first()
    .click()
  const d = await saved
  return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()) }
}

test('a read-only profile downloads a photo byte for byte and has no upload', async ({ page }) => {
  await openEntry(page, 'demo-ro', e2eDN('snapshot'))
  await expect(attrRow(page, 'jpegPhoto').locator('img')).toBeVisible()
  const file = await download(page, 'jpegPhoto')
  expect(file.name).toBe('uid=snapshot-jpegPhoto.jpg')
  expect(file.bytes.equals(readFileSync(PHOTO))).toBe(true)
  await expect(page.getByRole('button', exact('Edit'))).toHaveCount(0)
  await expect(page.getByText('Upload file…')).toHaveCount(0)
  // Raw values (in More) show a binary value's size, not its base64.
  const raw = async () => {
    await page.getByRole('button', exact('More')).click()
    await page.getByRole('button', exact('Raw values')).click()
  }
  await raw()
  const size = readFileSync(PHOTO).length
  await expect(attrRow(page, 'jpegPhoto')).toContainText(`base64, ${size} bytes`)
  await expect(attrRow(page, 'jpegPhoto')).not.toContainText(PHOTO_B64.slice(0, 40))
  await raw()
})

async function apply(dialog: Locator) {
  await dialog.getByRole('button', exact('Apply to demo')).click()
  await expect(dialog).toBeHidden()
}

test('upload a photo: preview, Apply, read back, Download gives the same file', async ({
  page,
}) => {
  await openEntry(page, 'demo', e2eDN('photoup'))
  await page.getByRole('button', exact('Edit')).click()
  const offered = (a: string) => page.locator(`[data-add-attribute] datalist option[value="${a}"]`)
  await expect(offered('jpegPhoto')).toHaveCount(1)
  await expect(offered('userCertificate;binary')).toHaveCount(1)
  const add = page.getByLabel('Add attribute', { exact: true })
  await add.fill('jpegPhoto')
  const adder = page.locator('[data-add-attribute]')
  await adder.getByLabel('Upload jpegPhoto file', { exact: true }).setInputFiles({
    name: 'big.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.alloc(1024 * 1024 + 1),
  })
  await expect(adder.getByRole('alert')).toHaveText('File is larger than 1 MiB')
  // A binary attribute takes a file: Enter in the name field opens the chooser.
  const chooser = page.waitForEvent('filechooser')
  await add.press('Enter')
  await (await chooser).setFiles(PHOTO)
  // The good file clears the error of the one before.
  await expect(adder.getByRole('alert')).toHaveCount(0)
  const row = attrRow(page, 'jpegPhoto')
  await expect(row.getByRole('img', { name: 'added' })).toBeVisible()
  await expect(row.locator('img')).toBeVisible()
  const dialog = await review(page)
  await expect(dialog).toContainText('add: jpegPhoto')
  // The review shows the picture and its size, not a wall of base64.
  await expect(dialog).toContainText(PHOTO_SUMMARY)
  await expect(dialog.getByRole('img', exact('jpegPhoto'))).toBeVisible()
  await expect(dialog).not.toContainText(PHOTO_B64.slice(0, 40))
  await apply(dialog)
  await page.reload()
  await expect(row.locator('img')).toBeVisible()
  const file = await download(page, 'jpegPhoto')
  expect(file.name).toBe('uid=photoup-jpegPhoto.jpg')
  expect(file.bytes.equals(readFileSync(PHOTO))).toBe(true)
})

test('delete a binary value', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('photodel'))
  await page.getByRole('button', exact('Edit')).click()
  const row = attrRow(page, 'jpegPhoto')
  await row.getByRole('button', exact('Delete jpegPhoto value')).click()
  await expect(row.getByRole('img', { name: 'deleted' })).toBeVisible()
  const dialog = await review(page)
  await expect(dialog).toContainText('delete: jpegPhoto')
  await apply(dialog)
  await expect(row).toHaveCount(0)
})

test('a second photo next to one, then a swap: OpenLDAP takes both', async ({ page }) => {
  const other = readFileSync(new URL('../../deploy/demo-ldif/photos/avatar-2.jpg', import.meta.url))
  await openEntry(page, 'demo', e2eDN('photoswap'))
  await page.getByRole('button', exact('Edit')).click()
  const row = attrRow(page, 'jpegPhoto')
  // jpegPhoto has no equality rule: the server refuses a plain add next to a value.
  await row.getByLabel('Upload jpegPhoto file', { exact: true }).setInputFiles({
    name: 'other.jpg',
    mimeType: 'image/jpeg',
    buffer: other,
  })
  await apply(await review(page))
  await expect(row.locator('img')).toHaveCount(2)
  // Swap: delete the first photo and upload a third one in one apply.
  await row.getByRole('button', exact('Delete jpegPhoto value')).first().click()
  await row.getByLabel('Upload jpegPhoto file', { exact: true }).setInputFiles({
    name: 'third.jpg',
    mimeType: 'image/jpeg',
    buffer: readFileSync(new URL('../../deploy/demo-ldif/photos/avatar-3.jpg', import.meta.url)),
  })
  await apply(await review(page))
  await expect(row.locator('img')).toHaveCount(2)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a file over 1 MiB is refused at its field and stages nothing', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('bigfile'))
  await page.getByRole('button', exact('Edit')).click()
  const row = attrRow(page, 'jpegPhoto')
  await row.getByLabel('Upload jpegPhoto file', { exact: true }).setInputFiles({
    name: 'big.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.alloc(1024 * 1024 + 1),
  })
  await expect(row.getByRole('alert')).toHaveText('File is larger than 1 MiB')
  await expect(pendingBar(page)).toHaveCount(0)
  // Edit off: no upload, so no error about one.
  await page.getByRole('button', exact('Edit')).click()
  await expect(row.getByLabel('Upload jpegPhoto file', { exact: true })).toHaveCount(0)
  await expect(row.getByRole('alert')).toHaveCount(0)
})

test('cn;lang-de is added and changed apart from cn', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('langer'))
  await page.getByRole('button', exact('Edit')).click()
  await page.getByLabel('Add attribute', { exact: true }).fill('cn;lang-de')
  const first = page.getByLabel('cn;lang-de value', { exact: true })
  await first.fill('Sprache')
  await first.press('Enter')
  let dialog = await review(page)
  await expect(dialog).toContainText('cn;lang-de: Sprache')
  await apply(dialog)
  // Edit stays on after Apply: the value is an editor now.
  const row = attrRow(page, 'cn;lang-de')
  const input = row.locator('input').first()
  await expect(input).toHaveValue('Sprache')
  await input.fill('Sprache Zwei')
  await input.press('Enter')
  dialog = await review(page)
  const ldif = (await dialog.locator('pre').first().textContent()) ?? ''
  expect(ldif).toContain(
    'delete: cn;lang-de\ncn;lang-de: Sprache\n-\nadd: cn;lang-de\ncn;lang-de: Sprache Zwei\n-',
  )
  expect(ldif).not.toMatch(/^(add|delete): cn$/m)
  await apply(dialog)
  // Read back with Edit off, so the values show as text.
  await page.reload()
  await expect(row).toContainText('Sprache Zwei')
  await expect(attrRow(page, 'cn')).toContainText('E2E langer')
})

test('a certificate goes in as userCertificate;binary', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('certholder'))
  await page.getByRole('button', exact('Edit')).click()
  await page.getByLabel('Add attribute', { exact: true }).fill('userCertificate')
  await page.getByLabel('Upload userCertificate;binary file', { exact: true }).setInputFiles(CERT)
  const cert = readFileSync(CERT)
  const dialog = await review(page)
  await expect(dialog).toContainText('add: userCertificate;binary')
  await expect(dialog).toContainText(`userCertificate;binary:: (binary, ${cert.length} bytes)`)
  await apply(dialog)
  await expect(attrRow(page, 'userCertificate;binary')).toContainText(
    `binary, ${cert.length} bytes`,
  )
})

test('Clone carries the photo into the new entry', async ({ page }) => {
  await openEntry(page, 'demo', e2eDN('clonephoto'))
  await page.getByRole('button', exact('More')).click()
  await page.getByRole('button', exact('Clone')).click()
  const dialog = page.getByRole('dialog', { name: 'Clone entry' })
  await expect(dialog.locator('[data-attr="jpegPhoto"] img')).toBeVisible()
  await expect(dialog.locator('details pre')).toContainText(PHOTO_SUMMARY)
  await dialog.getByLabel('RDN value').fill('clonephoto2')
  await dialog.getByRole('button', exact('Create')).click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/dn=uid%3Dclonephoto2%2Cou%3De2e/)
  const file = await download(page, 'jpegPhoto')
  expect(file.bytes.equals(readFileSync(PHOTO))).toBe(true)
})

test('New child takes an uploaded photo; a file over 1 MiB stays out', async ({ page }) => {
  await openEntry(page, 'demo', E2E_OU)
  await blur(page)
  await page.keyboard.press('n')
  const dialog = page.getByRole('dialog', { name: 'New child entry' })
  await dialog.getByLabel('Structural class').selectOption('inetOrgPerson')
  await dialog.getByLabel('RDN value').fill('newphoto')
  await dialog.getByLabel('cn value', { exact: true }).fill('New Photo')
  await dialog.getByLabel('sn value', { exact: true }).fill('Photo')
  await dialog.getByLabel('Add attribute', { exact: true }).selectOption('jpegPhoto')
  const row = dialog.locator('[data-attr="jpegPhoto"]')
  const upload = row.getByLabel('Upload jpegPhoto file', { exact: true })
  await upload.setInputFiles({
    name: 'big.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.alloc(1024 * 1024 + 1),
  })
  await expect(row.getByRole('alert')).toHaveText('File is larger than 1 MiB')
  await upload.setInputFiles(PHOTO)
  await expect(row.locator('img')).toBeVisible()
  await expect(row.getByRole('alert')).toHaveCount(0)
  await dialog.getByRole('button', exact('Create')).click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/dn=uid%3Dnewphoto%2Cou%3De2e/)
  await expect(attrRow(page, 'jpegPhoto').locator('img')).toBeVisible()
})

test('edit, delete a photo, upload another: the page stays put under the header', async ({
  page,
}) => {
  // A short window puts the upload field below the fold, as on an entry with many attributes.
  await page.setViewportSize({ width: 1280, height: 420 })
  await openEntry(page, 'demo', e2eDN('photoscroll'))
  await page.getByRole('button', exact('Edit')).click()
  const row = attrRow(page, 'jpegPhoto')
  await row.getByRole('button', exact('Delete jpegPhoto value')).first().click()
  await row.getByLabel('Upload jpegPhoto file', { exact: true }).setInputFiles({
    name: 'fourth.jpg',
    mimeType: 'image/jpeg',
    buffer: readFileSync(new URL('../../deploy/demo-ldif/photos/avatar-4.jpg', import.meta.url)),
  })
  await expect(row.getByRole('img', { name: 'added' })).toBeVisible()
  const page_ = await page.evaluate(() => ({
    top: document.scrollingElement!.scrollTop,
    height: document.scrollingElement!.scrollHeight,
  }))
  expect(page_).toEqual({ top: 0, height: page.viewportSize()!.height })
  await expect(pendingBar(page)).toBeInViewport()
})
