/**
 * Runs an effect against the `TestClock` (`it.effect`).
 */
import { Duration, Effect, Fiber, TestClock } from "effect";

/**
 * Real macrotask: lets promise based fakes (`fakeFetch`) settle, so the code after them has registered its sleeps.
 * Call it after forking and after every `TestClock.adjust` when the code under test awaits promises.
 */
export const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

const STEP_MS = 100;

/**
 * Forks `effect`, moves the clock by `duration` in steps of 100ms (letting promises settle between steps), joins.
 * Sleeps are therefore woken at most one step late. Use `TestClock.adjust` directly when exact times matter.
 */
export const runWithClock = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  duration: Duration.DurationInput,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(effect);
    yield* settle;
    let remaining = Duration.toMillis(duration);
    while (remaining > 0) {
      const step = Math.min(STEP_MS, remaining);
      yield* TestClock.adjust(step);
      yield* settle;
      remaining -= step;
    }
    return yield* Fiber.join(fiber);
  });
