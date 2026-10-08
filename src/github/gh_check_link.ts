/**
 * Checks a GitHub URL with the GitHub API (links through `fetch` hit the rate limit quickly).
 * Callers route wiki links, GitHub's own pages and non-GitHub URLs elsewhere (see `getInitialCheckMethod` in `link.ts`).
 * STUB: implemented by the GITHUB group.
 */
import { Effect } from "effect";
import type { GitHubTimeout } from "../errors";
import type { Fetch } from "../http";
import type { HostLimiter } from "../limiter";
import type { Metrics } from "../metrics";
import type { LinkCheckResult } from "../types";
import type { GitHub } from "./github_client";

export const checkLinkWithGithubApi: (
  url: string,
) => Effect.Effect<LinkCheckResult, GitHubTimeout, GitHub | Fetch | HostLimiter | Metrics> = () =>
  Effect.die("not implemented");
