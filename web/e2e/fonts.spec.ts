import { connect } from './helpers'
import { expect, test, type Page } from './test'

const FONTS = ['Inter Variable', 'JetBrains Mono Variable']

/** The FONTS the page has loaded and can render with. */
const usable = (page: Page) =>
  page.evaluate(async (fonts) => {
    await document.fonts.ready
    // check() alone is true for a family nothing declares, so also require a loaded face.
    const loaded = new Set(
      [...document.fonts]
        .filter((f) => f.status === 'loaded')
        .map((f) => f.family.replace(/"/g, '')),
    )
    return fonts.filter((f) => loaded.has(f) && document.fonts.check(`13px "${f}"`))
  }, FONTS)

// The UI works offline: its fonts load, and nothing (fonts included) comes from another origin.
test('bundled fonts load from the page origin', async ({ page }) => {
  const urls: string[] = []
  page.on('request', (r) => urls.push(r.url()))
  await connect(page, 'demo')
  await expect.poll(() => usable(page)).toEqual(FONTS)
  const origin = new URL(page.url()).origin
  expect(urls.filter((u) => new URL(u).origin !== origin)).toEqual([])
})
