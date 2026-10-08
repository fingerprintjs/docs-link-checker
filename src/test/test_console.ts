/**
 * `Console` that records output, to assert stdout and stderr separately. Use with `Effect.withConsole`.
 * The leveled logger writes through `unsafe`, so that records too.
 */
import { format } from "node:util";
import { Console, Effect } from "effect";

export const makeTestConsole = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = (...args: ReadonlyArray<unknown>) => void stdout.push(format(...args));
  const err = (...args: ReadonlyArray<unknown>) => void stderr.push(format(...args));
  const noop = () => {};
  const sync =
    (f: (...args: ReadonlyArray<unknown>) => void) =>
    (...args: ReadonlyArray<unknown>) =>
      Effect.sync(() => f(...args));

  const console: Console.Console = {
    [Console.TypeId]: Console.TypeId,
    assert: sync(noop),
    clear: Effect.void,
    count: sync(noop),
    countReset: sync(noop),
    debug: sync(out),
    dir: sync(noop),
    dirxml: sync(noop),
    error: sync(err),
    group: sync(noop),
    groupEnd: Effect.void,
    info: sync(out),
    log: sync(out),
    table: sync(noop),
    time: sync(noop),
    timeEnd: sync(noop),
    timeLog: sync(noop),
    trace: sync(err),
    warn: sync(err),
    unsafe: {
      assert: noop,
      clear: noop,
      count: noop,
      countReset: noop,
      debug: out,
      dir: noop,
      dirxml: noop,
      error: err,
      group: noop,
      groupCollapsed: noop,
      groupEnd: noop,
      info: out,
      log: out,
      table: noop,
      time: noop,
      timeEnd: noop,
      timeLog: noop,
      trace: err,
      warn: err,
    },
  };
  return { console, stdout, stderr };
};
