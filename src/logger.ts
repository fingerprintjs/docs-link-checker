/**
 * Logging. Output is plain text without timestamp or level (like `console.log`), so reports and CI logs read
 * the same as the messages in the code. Only the stream differs by level.
 * - https://effect.website/docs/observability/logging/
 */
import { Inspectable, type Layer, Logger } from "effect";

const plain = Logger.make<unknown, string>(({ message }) =>
  (Array.isArray(message) ? message : [message])
    .map((part: unknown) => (typeof part === "string" ? part : Inspectable.toStringUnknown(part)))
    .join(" "),
);

/**
 * - default: info to stdout, warnings and errors to stderr
 * - `json`: everything to stderr, stdout is only the JSON report
 */
export const LogLayer = (options: { readonly json: boolean }): Layer.Layer<never> =>
  Logger.replace(
    Logger.defaultLogger,
    options.json ? Logger.withConsoleError(plain) : Logger.withLeveledConsole(plain),
  );
