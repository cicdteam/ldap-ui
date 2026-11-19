import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureLDIF } from './fixture'

const here = dirname(fileURLToPath(import.meta.url))
export const TMP = join(here, '.tmp')
export const COMPOSE = join(here, '../../deploy/e2e/docker-compose.yml')

export function compose(...args: string[]): void {
  execFileSync('docker', ['compose', '-f', COMPOSE, ...args], { stdio: 'inherit' })
}

export default function setup(): void {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(join(TMP, 'e2e.ldif'), fixtureLDIF())
  compose('down', '-v')
  compose('up', '-d', '--build', '--wait')
  // up --wait already waited for Samba's healthcheck (an LDAPS bind). The bind is probed again,
  // retried for up to 30 s, so that ldapadd, which runs once per LDIF, finds Samba answering.
  for (let i = 0; ; i++) {
    try {
      samba('ldapwhoami')
      break
    } catch (e) {
      if (i >= 30) throw e
      execFileSync('sleep', ['1'])
    }
  }
  seed('ad-demo.ldif')
  seed('ad-seed.ldif')
}

/**
 * Runs one of the image's LDAP tool wrappers in the Samba container. They bind as Administrator
 * (-x -y /root/.ldappass) to ldaps://localhost (/root/.ldaprc).
 */
function samba(...args: string[]): void {
  execFileSync('docker', ['compose', '-f', COMPOSE, 'exec', '-T', 'samba', ...args], {
    stdio: 'pipe',
  })
}

/** Adds a mounted LDIF (deploy/e2e/docker-compose.yml) to Samba. */
function seed(file: string): void {
  samba('ldapadd', '-f', `/seed/${file}`)
}
