import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { LogLayer } from "./logger";
import { makeTestConsole } from "./test/test_console";

const logAll = (json: boolean) => {
  const testConsole = makeTestConsole();
  const run = Effect.gen(function* () {
    yield* Effect.logInfo("info message");
    yield* Effect.logWarning("warning message");
    yield* Effect.logError("error message");
    yield* Effect.log("two", "parts", 3);
  }).pipe(Effect.provide(LogLayer({ json })), Effect.withConsole(testConsole.console));
  return { run, ...testConsole };
};

describe("LogLayer", () => {
  it.effect("prints plain text: info to stdout, warnings and errors to stderr", () => {
    const logs = logAll(false);
    return logs.run.pipe(
      Effect.tap(() => {
        expect(logs.stdout).toEqual(["info message", "two parts 3"]);
        expect(logs.stderr).toEqual(["warning message", "error message"]);
      }),
    );
  });

  it.effect("with json, everything goes to stderr so stdout stays clean", () => {
    const logs = logAll(true);
    return logs.run.pipe(
      Effect.tap(() => {
        expect(logs.stdout).toEqual([]);
        expect(logs.stderr).toEqual([
          "info message",
          "warning message",
          "error message",
          "two parts 3",
        ]);
      }),
    );
  });
});
