import { execFileSync } from 'node:child_process'
import { expect, type Page } from '@playwright/test'
import { COMPOSE } from './global-setup'

/** Opens the connections page and connects profile (stored password). */
export async function connect(page: Page, profile: string): Promise<void> {
  await page.goto('./')
  // Not \b: "demo" must not match "demo-pw".
  await page.getByRole('button', { name: new RegExp(`^${profile}(?![\\w-])`) }).click()
  await expect(page).toHaveURL(new RegExp(`/c/${profile}(?:[/?#]|$)`))
  // A shared profile that an earlier spec connected opens at once, without
  // the connect dialog: wait for the workspace, whose keys work by then.
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible()
}

/** Connects, then deep-links to dn in the inspector. */
export async function openEntry(page: Page, profile: string, dn: string): Promise<void> {
  await connect(page, profile)
  await page.goto(`c/${profile}/entry?dn=${encodeURIComponent(dn)}`)
  await expect(page.locator('[data-attr]').first()).toBeVisible()
}

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
