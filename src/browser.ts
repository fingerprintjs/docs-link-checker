/**
 * Shared Chromium for the Playwright re-checks: lazy launch, page slots, crash retry.
 * STUB: tags and signatures are final, `Browser.layer` is implemented by the BROWSER group.
 */
import { Context, Effect, Layer } from "effect";
import { chromium, type BrowserType, type Page } from "playwright";
import type { BrowserLaunchError } from "./errors";
import { PlaywrightError } from "./errors";
import type { Metrics } from "./metrics";

// How many Playwright pages (browser contexts) are open at the same time
export const PLAYWRIGHT_CONCURRENCY_LIMIT = 5;

/** The only place `chromium` is referenced. Faked in tests instead of mocking the `playwright` module. */
export class Chromium extends Context.Tag("Chromium")<Chromium, Pick<BrowserType, "launch">>() {
  static readonly layer: Layer.Layer<Chromium> = Layer.succeed(Chromium, {
    launch: (options) => chromium.launch(options),
  });
}

/** Promise-returning Playwright call as an effect (the only place Playwright errors are caught) */
export const tryPlaywright = <A>(f: () => Promise<A>): Effect.Effect<A, PlaywrightError> =>
  Effect.tryPromise({ try: f, catch: (cause) => new PlaywrightError({ cause }) });

export class Browser extends Context.Tag("Browser")<
  Browser,
  {
    /**
     * Fresh page in its own context of the shared browser. At most `PLAYWRIGHT_CONCURRENCY_LIMIT` pages at a time.
     * Images, media, fonts and analytics are blocked. If the browser crashed (disconnected) it is relaunched and
     * `use` runs again once, then the original error surfaces.
     */
    readonly withPage: <A, E, R>(
      options: { readonly userAgent?: string; readonly timeout: number },
      use: (page: Page) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | BrowserLaunchError | PlaywrightError, R>;
  }
>() {
  // STUB
  static readonly layer: Layer.Layer<Browser, never, Chromium | Metrics> = Layer.succeed(Browser, {
    withPage: () => Effect.die("not implemented"),
  });
}
