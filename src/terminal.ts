/**
 * Terminal output of a run: finished steps (`✓ Found 21 links in 5 files  36ms`), live progress and colors.
 * - Colors use `styleText`, it follows NO_COLOR / FORCE_COLOR and prints plain text when the stream is not a TTY:
 *   https://nodejs.org/api/util.html#utilstyletextformat-text-options
 * - On a TTY the progress is one line that is redrawn, otherwise a line is printed at most every 10%, after the first 5s of a step.
 * - Results and the verdict are formatted in `src/report/cli.ts`.
 */
import { styleText } from "node:util";

type Format = Parameters<typeof styleText>[0];

export type Paint = (format: Format, text: string) => string;

export type Terminal = {
  paint: Paint;
  /** A permanent line, an empty one by default */
  line: (text?: string) => void;
  /** A finished step, with the time since the previous one: `✓ label detail  219ms` */
  done: (label: string, detail?: string) => void;
  /** Step in progress: a redrawn line on a TTY, a line at most every 10% otherwise (after 5s) */
  progress: (label: string, done: number, total: number, failing?: number) => void;
  /** Removes the progress line (if any), to print something else or to leave */
  clear: () => void;
  /** Extra details, printed with --verbose only */
  verbose: (text: string) => void;
};

type TerminalOptions = {
  write: (text: string) => void;
  /** The stream the text ends up on, decides about colors */
  stream: NodeJS.WriteStream;
  /** Redraw the progress line. Defaults to `stream.isTTY`. */
  tty?: boolean;
  verbose?: boolean;
  now?: () => number;
};

/** `219ms`, `18.8s`, `52s`, `3m 12s` */
export const formatDuration = (ms: number): string => {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${Number((ms / 1000).toFixed(1))}s`;
  }
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

export const formatCount = (count: number): string => count.toLocaleString("en-US");

/** `1 link`, `2 links` */
export const plural = (count: number, noun: string): string =>
  `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;

const BAR_WIDTH = 24;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const REDRAW_INTERVAL_MS = 100;
/** Without a TTY, no progress lines in the first seconds of a step */
const QUIET_STEP_MS = 5000;
const CLEAR_LINE = "\r\u001B[2K";

export const createTerminal = ({
  write,
  stream,
  tty = stream.isTTY,
  verbose = false,
  now = () => performance.now(),
}: TerminalOptions): Terminal => {
  const paint: Paint = (format, text) => styleText(format, text, { stream });
  let stepStart = now();
  // The step being shown by `progress`, `undefined` when nothing is drawn
  let current: { label: string; start: number; lastDraw: number; lastBucket: number } | undefined;
  // Is a progress line on screen that the next output has to remove?
  let drawn = false;
  let frame = 0;

  const clear = () => {
    if (drawn) {
      write(CLEAR_LINE);
      drawn = false;
    }
  };
  const line = (text = "") => {
    clear();
    write(`${text}\n`);
  };

  const drawBar = (label: string, done: number, total: number, failing: number) => {
    const ratio = total > 0 ? done / total : 1;
    const filled = Math.round(ratio * BAR_WIDTH);
    const elapsed = now() - (current?.start ?? 0);
    const eta =
      done > 0
        ? `ETA ${formatDuration(Math.ceil(((elapsed / done) * (total - done)) / 1000) * 1000)}`
        : "";
    const failingText = failing > 0 ? `${failing} failing so far` : "";
    const spinner = SPINNER[frame++ % SPINNER.length] ?? "";
    const bar = paint("cyan", "━".repeat(filled)) + paint("dim", "─".repeat(BAR_WIDTH - filled));
    const percent = `${Math.floor(ratio * 100)}%`.padStart(4);
    const tail = [eta, failingText].filter(Boolean).join(" · ");
    drawn = true;
    write(
      `${CLEAR_LINE}${paint("cyan", spinner)} ${label}  ${formatCount(done)}/${formatCount(total)}  ${bar} ${percent}  ${paint("dim", tail)}`,
    );
  };

  return {
    paint,
    line,
    clear,
    done: (label, detail) => {
      const time = now() - stepStart;
      stepStart = now();
      current = undefined;
      const parts = [detail && paint("dim", detail), paint("dim", formatDuration(time))];
      line(`${paint("green", "✓")} ${label} ${parts.filter(Boolean).join("  ")}`);
    },
    progress: (label, done, total, failing = 0) => {
      if (current?.label !== label) {
        current = { label, start: now(), lastDraw: Number.NEGATIVE_INFINITY, lastBucket: 0 };
      }
      if (tty) {
        if (now() - current.lastDraw >= REDRAW_INTERVAL_MS) {
          current.lastDraw = now();
          drawBar(label, done, total, failing);
        }
        return;
      }
      const bucket = total > 0 ? Math.floor((done / total) * 10) : 0;
      // Short steps print only their done line, progress lines would just be noise in CI logs
      if (bucket > current.lastBucket && now() - current.start >= QUIET_STEP_MS) {
        current.lastBucket = bucket;
        const failingText = failing > 0 ? `, ${failing} failing so far` : "";
        write(
          `${label} ${bucket * 10}% (${formatCount(done)}/${formatCount(total)}${failingText})\n`,
        );
      }
    },
    verbose: (text) => {
      if (verbose) {
        line(paint("dim", text));
      }
    },
  };
};

/** Output of runs that have no terminal (tests, library use): prints nothing */
export const createSilentTerminal = (): Terminal =>
  createTerminal({ write: () => {}, stream: process.stdout, tty: false });
