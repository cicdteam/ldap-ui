import { test as base, expect } from '@playwright/test'

// Specs import test and expect (and Playwright's types) from here, not from @playwright/test, so
// that every test runs under the fixture below.
export * from '@playwright/test'

type Violating = Window & { reportCSPViolation: (violation: string) => void }

export const test = base.extend<{ failOnPageErrors: void }>({
  /**
   * Fails the test on an uncaught exception or unhandled rejection in any of its pages, and on any
   * Content-Security-Policy violation, whatever the test itself asserts.
   */
  failOnPageErrors: [
    async ({ context }, use) => {
      const errors: string[] = []
      const violations: string[] = []
      context.on('weberror', (e) => errors.push(e.error().stack ?? e.error().message))
      await context.exposeBinding('reportCSPViolation', (_, v: string) => violations.push(v))
      await context.addInitScript(() =>
        document.addEventListener('securitypolicyviolation', (e) =>
          (window as unknown as Violating).reportCSPViolation(
            `${e.effectiveDirective} ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`,
          ),
        ),
      )
      await use()
      expect(errors, 'uncaught errors in the page').toEqual([])
      expect(violations, 'Content-Security-Policy violations').toEqual([])
    },
    { auto: true },
  ],
})
