import { test as base, expect, type BrowserContext } from '@playwright/test'

// Specs import test and expect (and Playwright's types) from here, not from @playwright/test, so
// that every test runs under the fixture below.
export * from '@playwright/test'

type Violating = Window & { reportCSPViolation: (violation: string) => void }

// React Router's default error boundary catches a crash in render and only logs it.
const RENDER_CRASH = 'React Router caught the following error during render'

/**
 * Watches every page of context for uncaught exceptions, unhandled rejections, render crashes and
 * Content-Security-Policy violations. The returned check fails on any of them; call it before the
 * context closes. The fixture below watches the test's own context; a spec that opens another one
 * watches it itself.
 */
export async function watch(context: BrowserContext): Promise<() => Promise<void>> {
  const errors: string[] = []
  const violations: string[] = []
  context.on('weberror', (e) => errors.push(e.error().stack ?? e.error().message))
  // Only this message: other console errors are expected, such as a refused sign-in's 401.
  context.on('console', (m) => {
    if (m.type() === 'error' && m.text().startsWith(RENDER_CRASH)) errors.push(m.text())
  })
  await context.exposeBinding('reportCSPViolation', (_, v: string) => violations.push(v))
  await context.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as Violating).reportCSPViolation(
        `${e.effectiveDirective} ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`,
      ),
    ),
  )
  return async () => {
    // One round trip per page, so what the last step raised has arrived. A page that is
    // navigating or closing answers with an error, which is not the test's.
    for (const page of context.pages()) await page.evaluate(() => 0).catch(() => {})
    expect(errors, 'uncaught errors in the page').toEqual([])
    expect(violations, 'Content-Security-Policy violations').toEqual([])
  }
}

export const test = base.extend<{ failOnPageErrors: void }>({
  /** Fails the test on what watch collects, whatever the test itself asserts. */
  failOnPageErrors: [
    async ({ context }, use) => {
      const check = await watch(context)
      await use()
      await check()
    },
    { auto: true },
  ],
})
