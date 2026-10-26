import type * as PlayerTypes from '../src/player.js';
import type { JSHandle, Page } from 'playwright';

type PlayerModule = typeof PlayerTypes;
type PollValue<Arg> = { app: JSHandle<PlayerModule>; arg: Arg };

// Keep Playwright polling synchronous while reading live ESM bindings.
// An async waitForFunction predicate returns a truthy Promise before its result.
export async function waitForPlayer<Arg = undefined, Result = unknown>(
  page: Page,
  predicate: Parameters<typeof page.waitForFunction<Result, PollValue<Arg>>>[0],
  arg?: Arg,
  options?: Parameters<Page['waitForFunction']>[2],
) {
  const app = await page.evaluateHandle(() => import('/static/player.js'));
  try {
    return await page.waitForFunction<Result, PollValue<Arg>>(predicate, { app, arg: arg as Arg }, options);
  } finally {
    await app.dispose();
  }
}
