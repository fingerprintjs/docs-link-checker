import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref, TestClock } from "effect";
import { describe, expect } from "vitest";
import { HostLimiter } from "./limiter";

const limited = <A, E, R>(hostConcurrency: number, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(HostLimiter.layer(hostConcurrency)));

describe("HostLimiter", () => {
  it.effect("limits concurrency per host, hosts are independent", () =>
    limited(
      2,
      Effect.gen(function* () {
        const limiter = yield* HostLimiter;
        const active = yield* Ref.make<Record<string, number>>({});
        const max = yield* Ref.make<Record<string, number>>({});
        const track = (host: string, by: number) =>
          Ref.updateAndGet(active, (state) => ({ ...state, [host]: (state[host] ?? 0) + by })).pipe(
            Effect.flatMap((state) =>
              Ref.update(max, (maxima) => ({
                ...maxima,
                [host]: Math.max(maxima[host] ?? 0, state[host] ?? 0),
              })),
            ),
          );

        const urls = Array.from(
          { length: 30 },
          (_, i) => `https://host-${i % 3}.example.com/page-${i}`,
        );
        const all = yield* Effect.forEach(
          urls,
          (url) => {
            const host = new URL(url).hostname;
            return limiter.withSlot(
              url,
              track(host, 1).pipe(
                Effect.zipRight(Effect.sleep(5)),
                Effect.zipRight(track(host, -1)),
              ),
            );
          },
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.fork);
        yield* TestClock.adjust(1000);
        yield* Fiber.join(all);

        expect(Object.values(yield* Ref.get(max))).toEqual([2, 2, 2]);
      }),
    ),
  );

  it.effect("starts queued requests of a host in order", () =>
    limited(
      1,
      Effect.gen(function* () {
        const limiter = yield* HostLimiter;
        const started = yield* Ref.make<number[]>([]);
        const fiber = yield* Effect.forEach(
          [1, 2, 3, 4],
          (n) =>
            limiter.withSlot(
              "https://fifo.example.com/",
              Ref.update(started, (order) => [...order, n]).pipe(Effect.zipRight(Effect.sleep(1))),
            ),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.fork);
        yield* TestClock.adjust(10);
        yield* Fiber.join(fiber);

        expect(yield* Ref.get(started)).toEqual([1, 2, 3, 4]);
      }),
    ),
  );

  it.effect("does not limit unparsable URLs", () =>
    limited(
      1,
      Effect.gen(function* () {
        const limiter = yield* HostLimiter;
        const gate = yield* Deferred.make<void>();
        // The first request holds its "slot" until the second one finished, so the limit would deadlock
        const first = yield* limiter.withSlot("not a url", Deferred.await(gate)).pipe(Effect.fork);
        yield* limiter.withSlot("not a url", Effect.void);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
      }),
    ),
  );

  it.effect("releases the slot when a request is interrupted or fails", () =>
    limited(
      1,
      Effect.gen(function* () {
        const limiter = yield* HostLimiter;
        const url = "https://release.example.com/";
        const hanging = yield* limiter.withSlot(url, Effect.never).pipe(Effect.fork);
        yield* Effect.yieldNow();
        yield* Fiber.interrupt(hanging);
        yield* limiter.withSlot(url, Effect.fail("boom")).pipe(Effect.flip);
        // Would block forever if one of the slots leaked
        yield* limiter.withSlot(url, Effect.void);
      }),
    ),
  );

  describe("pause", () => {
    it.effect("delays new requests to a paused host, other hosts are not affected", () =>
      limited(
        5,
        Effect.gen(function* () {
          const limiter = yield* HostLimiter;
          yield* limiter.pause("https://paused.example.com/a", 50);

          const paused = yield* limiter
            .withSlot("https://paused.example.com/b", Effect.void)
            .pipe(Effect.fork);
          yield* limiter.withSlot("https://other.example.com/", Effect.void);
          yield* TestClock.adjust(49);
          expect(yield* Fiber.poll(paused)).toEqual(expect.objectContaining({ _tag: "None" }));
          yield* TestClock.adjust(1);
          yield* Fiber.join(paused);
        }),
      ),
    );

    it.effect("never shortens an existing pause, a longer one extends it", () =>
      limited(
        5,
        Effect.gen(function* () {
          const limiter = yield* HostLimiter;
          const url = "https://paused.example.com/";
          yield* limiter.pause(url, 100);
          yield* limiter.pause(url, 10);
          const waiting = yield* limiter.waitUntilResumed(url).pipe(Effect.fork);
          yield* TestClock.adjust(99);
          expect(yield* Fiber.poll(waiting)).toEqual(expect.objectContaining({ _tag: "None" }));
          // Extended while a request waits: it waits for the new end
          yield* limiter.pause(url, 100);
          yield* TestClock.adjust(1);
          expect(yield* Fiber.poll(waiting)).toEqual(expect.objectContaining({ _tag: "None" }));
          yield* TestClock.adjust(99);
          yield* Fiber.join(waiting);
        }),
      ),
    );

    it.effect("a pause set inside a slot holds back the queued request of the host", () =>
      limited(
        1,
        Effect.gen(function* () {
          const limiter = yield* HostLimiter;
          const started = yield* Ref.make<string[]>([]);
          const mark = (name: string) => Ref.update(started, (names) => [...names, name]);
          const url = "https://busy.example.com/";

          const first = yield* limiter
            .withSlot(url, mark("first").pipe(Effect.zipRight(limiter.pause(url, 1000))))
            .pipe(Effect.fork);
          const queued = yield* limiter.withSlot(url, mark("queued")).pipe(Effect.fork);
          yield* TestClock.adjust(999);
          expect(yield* Ref.get(started)).toEqual(["first"]);
          yield* TestClock.adjust(1);
          yield* Fiber.join(first);
          yield* Fiber.join(queued);
          expect(yield* Ref.get(started)).toEqual(["first", "queued"]);
        }),
      ),
    );

    it.effect("ignores unparsable URLs", () =>
      limited(
        1,
        Effect.gen(function* () {
          const limiter = yield* HostLimiter;
          yield* limiter.pause("not a url", 1000);
          yield* limiter.waitUntilResumed("not a url");
          yield* limiter.withSlot("not a url", Effect.void);
        }),
      ),
    );
  });
});
