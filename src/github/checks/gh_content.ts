/**
 * Blob and tree checks of GitHub links: refs with slashes, hashes, line anchors.
 * STUB: implemented by the GITHUB group.
 */
import { Effect } from "effect";
import type { GitHubTimeout } from "../../errors";
import type { LinkCheckResult } from "../../types";
import type { GitHub } from "../github_client";

export const checkGitHubBlobLink: (
  fullUrl: URL,
  owner: string,
  repo: string,
  pathParts: string[],
) => Effect.Effect<LinkCheckResult, GitHubTimeout, GitHub> = () => Effect.die("not implemented");

export const checkGitHubTreeLink: (
  owner: string,
  repo: string,
  pathParts: string[],
) => Effect.Effect<LinkCheckResult, GitHubTimeout, GitHub> = () => Effect.die("not implemented");
