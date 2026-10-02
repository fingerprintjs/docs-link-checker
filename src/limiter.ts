const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal counting semaphore: at most `limit` tasks run at the same time, the rest wait in FIFO order.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
    }
  }

  /** Number of tasks currently running */
  get activeCount() {
    return this.active;
  }

  /** Number of tasks waiting for a slot */
  get waitingCount() {
    return this.waiting.length;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    // The slot is handed over directly by `release`, so `active` stays the same
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

type HostState = { semaphore: Semaphore; pausedUntil: number };

/** Waits until the pause of the host ends (a pause can be extended while waiting) */
const waitForPause = async (state: HostState) => {
  while (state.pausedUntil > Date.now()) {
    await sleep(state.pausedUntil - Date.now());
  }
};

/**
 * Limits concurrent requests per hostname (one semaphore per host).
 * A host can also be paused (e.g. after a 429 with `Retry-After`), new requests to it wait until the pause ends.
 */
export class HostLimiter {
  private readonly hosts = new Map<string, HostState>();

  constructor(readonly limitPerHost: number) {}

  private getHost(url: string): HostState | undefined {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      // Invalid URL, the request itself will fail, no need to limit it
      return undefined;
    }
    let state = this.hosts.get(hostname);
    if (!state) {
      state = { semaphore: new Semaphore(this.limitPerHost), pausedUntil: 0 };
      this.hosts.set(hostname, state);
    }
    return state;
  }

  /** Runs `fn` once a slot for the URL's host is free (and the host is not paused) */
  async run<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const state = this.getHost(url);
    if (!state) {
      return fn();
    }
    return state.semaphore.run(async () => {
      await waitForPause(state);
      return fn();
    });
  }

  /**
   * Waits until the URL's host is no longer paused, without taking a slot. For requests that are not limited per host
   * but should still back off (Playwright navigations).
   */
  async waitUntilResumed(url: string): Promise<void> {
    const state = this.getHost(url);
    if (state) {
      await waitForPause(state);
    }
  }

  /** Pauses new requests to the URL's host for `ms` milliseconds */
  pause(url: string, ms: number) {
    const state = this.getHost(url);
    if (state) {
      state.pausedUntil = Math.max(state.pausedUntil, Date.now() + ms);
    }
  }

  /** Number of requests currently running for the URL's host (for tests and debugging) */
  activeCount(url: string): number {
    return this.getHost(url)?.semaphore.activeCount ?? 0;
  }
}

/**
 * Parses the `Retry-After` header (delay in seconds or an HTTP date) into milliseconds.
 * Returns `undefined` if the header is missing or invalid.
 */
export const parseRetryAfter = (value: string | null, now = Date.now()): number | undefined => {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  if (/^\d+$/.test(value.trim())) {
    return parseInt(value.trim(), 10) * 1000;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - now);
};

/**
 * Rejects if `promise` does not settle within `ms` milliseconds (the underlying work is not cancelled).
 */
export const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
