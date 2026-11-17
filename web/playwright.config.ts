import { defineConfig } from '@playwright/test'

// One worker: every spec talks to the same OpenLDAP and Samba AD.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:18091/ldap/',
    // The token e2e/serve.sh starts the server with.
    extraHTTPHeaders: { Authorization: 'Bearer e2e-token-000000000' },
    channel: 'chrome',
    headless: true,
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'sh e2e/serve.sh',
    url: 'http://127.0.0.1:18091/ldap/healthz',
    reuseExistingServer: false,
    timeout: 300_000,
  },
})
