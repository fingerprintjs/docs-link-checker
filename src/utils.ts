import PromisePool, { ProcessHandler } from "@supercharge/promise-pool";
import * as cliProgress from "cli-progress";

export const progressBar = new cliProgress.SingleBar({ stopOnComplete: true });

export const log = (message: any, verbose = false) => {
  if (verbose) {
    console.log(message);
  }
};

type ParallelProcessArgs<T, R> = {
  items: T[];
  processFn: ProcessHandler<T, R>;
  concurrencyLimit?: number;
};

export const parallelProcess = async <T, R>({
  items,
  processFn,
  concurrencyLimit = CONCURRENCY_LIMIT,
}: ParallelProcessArgs<T, R>) => {
  const startTime = Date.now();
  progressBar.start(items.length, 0);
  const { results, errors } = await PromisePool.withConcurrency(concurrencyLimit)
    .withTaskTimeout(TASK_TIMEOUT)
    .for(items)
    .onTaskFinished((_item, _pool) => {
      progressBar.increment();
    })
    .process(processFn);
  progressBar.stop();

  if (errors.length > 0) {
    console.error(`Errors processing items: ${errors.length}`, errors.toString());
  }
  const endTime = Date.now();
  console.log(`Time taken: ${endTime - startTime}ms`);
  return { results, errors };
};

export const CONCURRENCY_LIMIT = 100;
export const PLAYWRIGHT_CONCURRENCY_LIMIT = 5;
// GitHub web rate limit makes you wait 60 seconds after 500 requests
export const TASK_TIMEOUT = 80000;

export const OKAY_STATUS_CODES = [200, 301, 302, 303, 307, 308];
// Some websites have ReCaptcha or other anti-scraping measures that prevent us from checking their links, let's ignore/collect them separately
export const FORBIDDEN_STATUS_CODES = [403, 401];

// Spoofed user agents to bypass some websites restrictions

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:110.0) Gecko/20100101 Firefox/110.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/109.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Android 14; Mobile; rv:110.0) Gecko/110.0 Firefox/110.0",
  "Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/537.36",
  "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
];

export const getRandomUserAgent = () => userAgents[Math.floor(Math.random() * userAgents.length)];
