// Keep Playwright polling synchronous while reading live ESM bindings.
// An async waitForFunction predicate returns a truthy Promise before its result.
export async function waitForPlayer(page, predicate, arg, options) {
  const app = await page.evaluateHandle(() => import('/static/player.js'));
  try {
    return await page.waitForFunction(predicate, { app, arg }, options);
  } finally {
    await app.dispose();
  }
}
