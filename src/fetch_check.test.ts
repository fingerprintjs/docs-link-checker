import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLinkWithFetch } from "./fetch_check";
import { Metrics, RunLayer, type RunServices } from "./run";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const html = '<h2 id="intro">Intro</h2>';

/** Runs `effect` in a run of its own and returns its result with the counters of the run */
const inRun = <A>(effect: Effect.Effect<A, never, RunServices>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* effect;
      const { counters } = yield* Effect.flatMap(Metrics, (metrics) => metrics.snapshot);
      return { result, counters };
    }).pipe(Effect.provide(RunLayer({ hostConcurrency: 2 }))),
  );

describe("checkLinkWithFetch()", () => {
  it("fetches a page once for all links to it, with and without hash", async () => {
    const fetchMock = vi.fn(async () => new Response(html, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const pagesWithHash = new Set(["https://example.com/docs"]);

    const { result, counters } = await inRun(
      Effect.all(
        [
          checkLinkWithFetch("https://example.com/docs", pagesWithHash),
          checkLinkWithFetch("https://example.com/docs#intro", pagesWithHash),
          checkLinkWithFetch("https://example.com/docs#missing", pagesWithHash),
        ],
        { concurrency: "unbounded" },
      ),
    );

    expect(result).toEqual([
      { ok: true, status: 200 },
      { ok: true, status: 200 },
      { ok: false, status: 200, error: "hash not found" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(counters).toMatchObject({ uniquePagesFetched: 1, httpRequests: 1 });
  });

  it("does not cache the page between runs", async () => {
    const fetchMock = vi.fn(async () => new Response(html, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await inRun(checkLinkWithFetch("https://example.com/docs"));
    await inRun(checkLinkWithFetch("https://example.com/docs"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a network error as a broken link, not a failure of the effect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const { result } = await inRun(checkLinkWithFetch("https://example.com/down"));

    expect(result).toEqual({
      ok: false,
      error: "broken link",
      errorDetail: "TypeError: fetch failed",
    });
  });
});
