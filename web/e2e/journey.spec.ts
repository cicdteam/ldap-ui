import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { E2E_OU, e2eGroup, PHOTO } from './fixture'
import { TMP } from './global-setup'
import { attrRow, blur, canBind, exact, openEntry } from './helpers'

// The 3b, 3c and 3d success scenarios in one pass over the same entries, in an OU of their own; then
// the server log has every write and none of the values written.
const OU = `ou=journey,${E2E_OU}`
const OU2 = `ou=arrivals,${OU}`
const PERSON = `uid=voyager,${OU}`
const CLONE = `uid=voyager2,${OU}`
const MOVED = `uid=wanderer,${OU2}`
const NAMES = e2eGroup('journey-names')
const POSIX = e2eGroup('journey-posix')

// Never part of a DN, so none of them may reach the log.
const MAIL = 'k7q2.trail@mail.test'
const DESC = 'Scenic route 4wz9'
const UID_NUMBER = '7339281'
const GID_NUMBER = '7339282'
const HOME = '/home/trail-5mx8'
const PW_SSHA = 'Ssha secret 8hv3'
const PW_SERVER = 'Modify secret 2pt6'
const PHOTO_B64 = readFileSync(PHOTO).toString('base64')
const PHOTO_BYTES = readFileSync(PHOTO).length

const at = (dn: string) => new RegExp(`dn=${encodeURIComponent(dn)}(&|$)`)
const groupRow = (page: Page, dn: string) =>
  page.getByRole('region', exact('Member of')).locator(`[data-ref="${dn}"]`)

async function action(page: Page, item: string) {
  await page.getByRole('button', exact('Actions')).click()
  await page.getByRole('button', exact(item)).click()
}

/** Mod+S with nothing focused (see blur), then Apply in the review. */
async function reviewAndApply(page: Page, ...ldif: string[]) {
  await blur(page)
  await page.keyboard.press('ControlOrMeta+S')
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  for (const line of ldif) await expect(dialog).toContainText(line)
  await dialog.getByRole('button', exact('Apply')).click()
  await expect(dialog).toBeHidden()
}

test('journey: create, clone, move, classes, a photo, passwords, groups, delete; the log keeps no value', async ({
  page,
}) => {
  test.slow()
  const newChild = page.getByRole('dialog', { name: 'New child entry' })
  const createChild = async (cls: string, rdn: string) => {
    await blur(page)
    await page.keyboard.press('n')
    await newChild.getByLabel('Structural class').selectOption(cls)
    await newChild.getByLabel('RDN value').fill(rdn)
  }

  await test.step('create two OUs and a person with mail and description', async () => {
    await openEntry(page, 'demo', E2E_OU)
    await createChild('organizationalUnit', 'journey')
    await newChild.getByRole('button', exact('Create')).click()
    await expect(page).toHaveURL(at(OU))
    await createChild('organizationalUnit', 'arrivals')
    await newChild.getByRole('button', exact('Create')).click()
    await expect(page).toHaveURL(at(OU2))

    await page.goto(`c/demo/entry?dn=${encodeURIComponent(OU)}`)
    await expect(page.locator('[data-attr]').first()).toBeVisible()
    await createChild('inetOrgPerson', 'voyager')
    await newChild.getByLabel('cn value', { exact: true }).fill('Voyager One')
    await newChild.getByLabel('sn value', { exact: true }).fill('One')
    for (const [a, v] of [
      ['mail', MAIL],
      ['description', DESC],
    ]) {
      await newChild.getByLabel('Add attribute', { exact: true }).selectOption(a)
      await newChild.getByLabel(`${a} value`, { exact: true }).fill(v)
    }
    await newChild.getByRole('button', exact('Create')).click()
    await expect(newChild).toBeHidden()
    await expect(page).toHaveURL(at(PERSON))
    await expect(attrRow(page, 'mail')).toContainText(MAIL)
  })

  await test.step('clone the person, then rename and move the clone', async () => {
    await action(page, 'Clone')
    const clone = page.getByRole('dialog', { name: 'Clone entry' })
    await clone.getByLabel('RDN value').fill('voyager2')
    await clone.getByRole('button', exact('Create')).click()
    await expect(clone).toBeHidden()
    await expect(page).toHaveURL(at(CLONE))
    await expect(attrRow(page, 'description')).toContainText(DESC)
    await expect(attrRow(page, 'mail')).toHaveCount(0)

    await action(page, 'Rename/Move')
    const rename = page.getByRole('dialog', { name: 'Rename or move' })
    await rename.getByLabel('New RDN', { exact: true }).fill('uid=wanderer')
    await rename.getByLabel('New parent', { exact: true }).fill(OU2)
    await expect(rename).toContainText(MOVED)
    await rename.getByRole('button', exact('Apply')).click()
    await expect(rename).toBeHidden()
    await expect(page).toHaveURL(at(MOVED))
    await expect(attrRow(page, 'uid')).toContainText('wanderer')
  })

  const posix = [
    ['uidNumber', UID_NUMBER],
    ['gidNumber', GID_NUMBER],
    ['homeDirectory', HOME],
  ]
  await test.step('add posixAccount with its MUSTs, then remove it with them', async () => {
    await page.getByRole('button', exact('Edit')).click()
    const oc = attrRow(page, 'objectClass')
    await oc.getByLabel('Add object class', { exact: true }).selectOption('posixAccount')
    for (const [a, v] of posix) {
      await attrRow(page, a)
        .getByRole('button', exact(`Add ${a} value`))
        .click()
      const input = attrRow(page, a).locator('input').last()
      await input.fill(v)
      await input.press('Enter')
      await expect(attrRow(page, a).getByRole('alert')).toHaveCount(0)
    }
    await reviewAndApply(page, 'objectClass: posixAccount', `homeDirectory: ${HOME}`)

    await oc
      .locator('li', { hasText: 'posixAccount' })
      .getByRole('button', exact('Delete objectClass value'))
      .click()
    for (const [a] of posix)
      await attrRow(page, a)
        .getByRole('button', exact(`Delete ${a} value`))
        .click()
    await reviewAndApply(page, 'delete: objectClass')
    await page.reload()
    await expect(attrRow(page, 'objectClass')).not.toContainText('posixAccount')
    await expect(attrRow(page, 'uidNumber')).toHaveCount(0)
  })

  await test.step('upload a photo; the entry read back shows it', async () => {
    await page.getByRole('button', exact('Edit')).click()
    await page.getByLabel('Add attribute', { exact: true }).fill('jpegPhoto')
    await page.getByLabel('Upload jpegPhoto file', { exact: true }).setInputFiles(PHOTO)
    await expect(attrRow(page, 'jpegPhoto').getByRole('img', { name: 'added' })).toBeVisible()
    await reviewAndApply(page, 'add: jpegPhoto', `jpegPhoto:: (binary, ${PHOTO_BYTES} bytes)`)
    // The reload also turns Edit off, as the next steps expect.
    await page.reload()
    await expect(attrRow(page, 'jpegPhoto').locator('img')).toBeVisible()
  })

  await test.step('set the password with SSHA, then Password Modify; each one binds', async () => {
    const dialog = page.getByRole('dialog', { name: 'Set password' })
    for (const [hash, pw] of [
      ['SSHA', PW_SSHA],
      ['Server policy (Password Modify)', PW_SERVER],
    ]) {
      await action(page, 'Set password…')
      await dialog.getByLabel('New password').fill(pw)
      await dialog.getByLabel('Repeat').fill(pw)
      await dialog
        .getByRole('radiogroup', { name: 'Hash' })
        .getByRole('radio', { name: hash })
        .check()
      await dialog.getByRole('button', exact('Set')).click()
      await expect(dialog).toBeHidden()
      await expect(attrRow(page, 'userPassword')).toContainText('hidden (1 value)')
      expect(canBind(MOVED, pw)).toBe(true)
    }
    expect(canBind(MOVED, PW_SSHA)).toBe(false)
  })

  await test.step('join a groupOfNames and a posixGroup, then leave one', async () => {
    await page.getByRole('button', exact('Edit')).click()
    await page.getByRole('tab', { name: 'Membership' }).click()
    for (const group of [NAMES, POSIX]) {
      await page
        .getByRole('region', exact('Member of'))
        .getByRole('button', { name: 'Add to group…' })
        .click()
      const field = page.getByLabel('Add to group', { exact: true })
      await field.fill(group)
      await field.press('Enter')
      await expect(groupRow(page, group).getByRole('img', { name: 'added' })).toBeVisible()
    }
    await reviewAndApply(page, `member: ${MOVED}`, 'memberUid: wanderer')
    for (const group of [NAMES, POSIX]) {
      await expect(groupRow(page, group)).toBeVisible()
      await expect(groupRow(page, group).getByRole('img', { name: 'added' })).toHaveCount(0)
    }

    await groupRow(page, NAMES)
      .getByRole('button', exact(`Remove ${NAMES}`))
      .click()
    await expect(groupRow(page, NAMES).getByRole('img', { name: 'deleted' })).toBeVisible()
    await reviewAndApply(page, `dn: ${NAMES}`, 'delete: member')
    await expect(groupRow(page, NAMES)).toHaveCount(0)
    await expect(groupRow(page, POSIX)).toBeVisible()
  })

  await test.step('delete the entry', async () => {
    await action(page, 'Delete')
    const dialog = page.getByRole('dialog', { name: 'Delete entry' })
    await dialog.getByLabel('Type uid=wanderer to confirm').fill('uid=wanderer')
    await dialog.getByRole('button', exact('Delete')).click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(at(OU2))
    await page.goto(`c/demo/entry?dn=${encodeURIComponent(MOVED)}`)
    await expect(page.getByText('No entry at this DN.')).toBeVisible()
  })

  await test.step('the server log has every write and none of the values', async () => {
    const read = () => readFileSync(join(TMP, 'server.log'), 'utf8')
    await expect.poll(read).toContain(`msg=deleted profile=demo dn="${MOVED}"`)
    const log = read()
    const writes: [string, number][] = [
      [`msg=added profile=demo dn="${OU}"`, 1],
      [`msg=added profile=demo dn="${OU2}"`, 1],
      [`msg=added profile=demo dn="${PERSON}"`, 1],
      [`msg=added profile=demo dn="${CLONE}"`, 1],
      [`msg=renamed profile=demo dn="${CLONE}" newDN="${MOVED}"`, 1],
      [`msg=modified profile=demo dn="${MOVED}"`, 3],
      [`msg="password set" profile=demo dn="${MOVED}" method=ssha`, 1],
      [`msg="password set" profile=demo dn="${MOVED}" method=server`, 1],
      [`msg=modified profile=demo dn="${NAMES}"`, 2],
      [`msg=modified profile=demo dn="${POSIX}"`, 1],
      [`msg=deleted profile=demo dn="${MOVED}"`, 1],
    ]
    for (const [line, times] of writes) expect(log.split(line).length - 1, line).toBe(times)
    for (const v of [
      MAIL,
      DESC,
      UID_NUMBER,
      GID_NUMBER,
      HOME,
      PW_SSHA,
      PW_SERVER,
      '{SSHA}',
      PHOTO_B64.slice(0, 40),
    ])
      expect(log).not.toContain(v)
  })
})
