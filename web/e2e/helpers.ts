import { execFileSync } from 'node:child_process'
import { COMPOSE } from './global-setup'
import { expect, type Locator, type Page } from './test'

/** The connections page's row for profile; not \b: "demo" must not match "demo-pw". */
export const profileButton = (page: Page, profile: string) =>
  page.getByRole('button', { name: new RegExp(`^${profile}(?![\\w-])`) })

/** Opens the connections page and connects profile (stored password). */
export async function connect(page: Page, profile: string): Promise<void> {
  await page.goto('./')
  await profileButton(page, profile).click()
  await expect(page).toHaveURL(new RegExp(`/c/${profile}(?:[/?#]|$)`))
  // A shared profile that an earlier spec connected opens at once, without
  // the connect dialog: wait for the workspace, whose keys work by then.
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible()
}

/** Opens the connections page and clicks profile, which asks for a password: its dialog. */
export async function connectDialog(page: Page, profile: string): Promise<Locator> {
  await page.goto('./')
  await profileButton(page, profile).click()
  return page.getByRole('dialog')
}

/** Connects profile with a typed password, and a username for a profile that asks for one. */
export async function signIn(
  page: Page,
  profile: string,
  { username, password }: { username?: string; password: string },
): Promise<void> {
  const dialog = await connectDialog(page, profile)
  if (username !== undefined) await dialog.getByLabel('Username').fill(username)
  // "Password", or "Password for <bind DN>" when the profile names one.
  const field = dialog.getByLabel(/^Password/)
  await field.fill(password)
  await field.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/c/${profile}(?:[/?#]|$)`))
}

/** Connects, then deep-links to dn in the inspector. */
export async function openEntry(page: Page, profile: string, dn: string): Promise<void> {
  await connect(page, profile)
  await page.goto(`c/${profile}/entry?dn=${encodeURIComponent(dn)}`)
  await expect(page.locator('[data-attr]').first()).toBeVisible()
}

/** The header's query bar (a CodeMirror editor). */
export const queryBar = (page: Page) =>
  page.getByRole('textbox', { name: 'Search by name, uid or mail, an LDAP filter, or a DN' })

/** The list pane's search results. */
export const results = (page: Page) => page.getByRole('grid', exact('Search results'))

/** The pending-changes bar above the status bar, shown while changes are staged. */
export const pendingBar = (page: Page) => page.getByRole('status', { name: 'Pending changes' })

/** The pending bar's Review button, which opens the review dialog. */
export const reviewButton = (page: Page) =>
  pendingBar(page).getByRole('button', { name: /^Review/ })

/** Role options matching name exactly: getByRole('button', exact('Edit')). */
export const exact = (name: string) => ({ name, exact: true })

export const attrRow = (page: Page, name: string) => page.locator(`[data-attr="${name}"]`)

/** Values of an attribute row as shown (one per copy button). */
export const valueItems = (page: Page, name: string) =>
  attrRow(page, name).locator('li:has(button[aria-label^="Copy"])')

/** Changes the directory behind the UI's back (admin bind inside the container). */
export function ldapmodify(ldif: string): void {
  execFileSync(
    'docker',
    [
      'compose',
      '-f',
      COMPOSE,
      'exec',
      '-T',
      'openldap',
      'ldapmodify',
      '-x',
      '-H',
      'ldap://localhost:1389',
      '-D',
      'cn=admin,dc=example,dc=org',
      '-w',
      'adminpassword',
    ],
    { input: ldif, stdio: ['pipe', 'inherit', 'inherit'] },
  )
}

/** POSTs body to an API path (relative to <base href>, /ldap/) from the page, bypassing the UI. */
export async function postJSON(
  page: Page,
  path: string,
  body: unknown,
): Promise<{ status: number; code?: string }> {
  return page.evaluate(
    async ({ path, body }) => {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: r.status, code: ((await r.json()) as { code?: string }).code }
    },
    { path, body },
  )
}

/**
 * Leaves nothing focused, so a single-key shortcut reaches the window. A click on the page could
 * land in the tree, whose type-ahead owns the key.
 */
export async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

/** Mod+S with nothing focused (see blur): the review dialog, once open. */
export async function review(page: Page): Promise<Locator> {
  await blur(page)
  await page.keyboard.press('ControlOrMeta+S')
  const dialog = page.getByRole('dialog', { name: 'Review changes' })
  await expect(dialog).toBeVisible()
  return dialog
}

/** Opens the command palette (Mod+K, nothing focused) and types query: its search field. */
export async function palette(page: Page, query = ''): Promise<Locator> {
  await blur(page)
  await page.keyboard.press('ControlOrMeta+K')
  const input = page.locator('[cmdk-input]')
  await input.fill(query)
  return input
}

/** The palette's commands and entries whose text contains text. */
export const paletteItem = (page: Page, text: string) =>
  page.locator('[cmdk-item]', { hasText: text })

/** Whether dn can bind with password: a simple bind inside the container. */
export function canBind(dn: string, password: string): boolean {
  try {
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        COMPOSE,
        'exec',
        '-T',
        'openldap',
        'ldapwhoami',
        '-x',
        '-H',
        'ldap://localhost:1389',
        '-D',
        dn,
        '-w',
        password,
      ],
      { stdio: 'ignore' },
    )
    return true
  } catch {
    return false
  }
}

/** Binds to Samba as dn inside the container: '' when it works, else ldapwhoami's error. */
export function adBind(dn: string, password: string): string {
  try {
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        COMPOSE,
        'exec',
        '-T',
        '-e',
        'LDAPTLS_REQCERT=never',
        'samba',
        // Not the image's ldapwhoami wrapper, which binds as Administrator.
        '/usr/bin/ldapwhoami',
        '-x',
        '-H',
        'ldaps://localhost',
        '-D',
        dn,
        '-w',
        password,
      ],
      { stdio: 'pipe' },
    )
    return ''
  } catch (e) {
    return String((e as { stderr: Buffer }).stderr)
  }
}
