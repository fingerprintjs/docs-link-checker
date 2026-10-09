/** @jsx h */
/** @jsxFrag Fragment */
// npx/tsx defaults to React.createElement unless the factory is in this file.
/* oxlint-disable react/jsx-key -- rendered once to static HTML, rows are never diffed or reordered */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
// oxlint-disable-next-line eslint/no-unused-vars -- Fragment is used via @jsxFrag / tsconfig jsxFragmentFactory
import { Fragment, h } from "preact";
import { renderToStaticMarkup } from "preact-render-to-string";
import { type Baseline, EMPTY_BASELINE } from "../baseline";
import type { Link, LinkWithResult } from "../types";
import { diffLinksToFix, type PreviousReport } from "./compare";
import {
  countByKind,
  displayUrl,
  encodePath,
  formatLocation,
  groupByTarget,
  type IgnoredLink,
  findSiteOrigin,
  isHttpUrl,
  problemKind,
  problemLabel,
  shortReason,
  type TargetGroup,
} from "./format";
import { REPORT_CSS, REPORT_SCRIPT } from "./report_assets";

export type LinkCheckReport = ReturnType<typeof getJSONReport>;

type GetReportArgs = {
  links: LinkWithResult[];
  siteName: string;
  /** Failing links matching the baseline are moved to `ignored` and don't count towards `totalLinksToFix` */
  baseline?: Baseline;
  /** When the check finished */
  generatedAt: Date;
  /** How long the check took */
  durationMs: number;
  /** Adds `diff` (new and fixed links to fix) when given, see `loadPreviousReport` */
  previous?: PreviousReport;
};

/** Version of the JSON report format, raised when a field is removed or changes its meaning */
const REPORT_SCHEMA_VERSION = 1;

export const getJSONReport = ({
  links,
  siteName,
  baseline = EMPTY_BASELINE,
  generatedAt,
  durationMs,
  previous,
}: GetReportArgs) => {
  const ignored: IgnoredLink[] = [];
  const notIgnored: LinkWithResult[] = [];
  for (const link of links) {
    const entry = link.result.ok ? undefined : baseline.findEntry(link);
    if (entry) {
      ignored.push(entry.reason ? { ...link, ignoreReason: entry.reason } : link);
    } else {
      notIgnored.push(link);
    }
  }
  const withError = (error: string) =>
    notIgnored.filter((link) => !link.result.ok && link.result.error === error);

  const brokenLinks = withError("broken link");
  const hashNotFound = withError("hash not found");
  const couldNotCheck = withError("could not check");
  const unexpectedErrors = withError("unexpected error");

  const toFix = [...brokenLinks, ...hashNotFound, ...unexpectedErrors];

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    durationMs,
    siteName,
    summary: {
      linksChecked: links.length,
      totalLinksToFix: toFix.length,
      brokenLinks: brokenLinks.length,
      hashNotFound: hashNotFound.length,
      networkErrors: unexpectedErrors.length,
      couldNotCheck: couldNotCheck.length,
      ignored: ignored.length,
    },
    brokenLinks,
    hashNotFound,
    networkErrors: unexpectedErrors,
    couldNotCheck,
    ignored,
    ...(previous ? { diff: diffLinksToFix(previous, toFix) } : {}),
  };
};

/** Links that need fixing (count towards `totalLinksToFix`), in report order */
export const getLinksToFix = (report: LinkCheckReport): LinkWithResult[] => [
  ...report.brokenLinks,
  ...report.hashNotFound,
  ...report.networkErrors,
];

/**
 * Only allow http(s) URLs in `href` attributes (no `javascript:` or other schemes from scraped pages)
 */
const safeHref = (url: string): string | undefined => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};

export type RenderOptions = {
  /**
   * Base URL of the checked files, ending with `/` (e.g. `https://github.com/owner/repo/blob/<sha>/`, see
   * `getGithubBlobBaseUrl`). Local pages (files reports) and their relative links are linked to it.
   * Without it, local values are rendered as plain text: a relative `href` would resolve against the report file,
   * not the checked files.
   */
  sourceBaseUrl?: string;
};

/** Keeps a URL only if it is inside the base URL (a `../` link must not leave the repository) */
const insideBase = (url: URL, base: string): string | undefined =>
  url.href.startsWith(base) ? safeHref(url.href) : undefined;

/** URL of a local file (the page of a link), with its line: `<base>docs/a.md#L7` */
const getLocalFileUrl = (
  base: string | undefined,
  path: string,
  line?: number,
): string | undefined => {
  if (!base) return undefined;
  try {
    const url = new URL(encodePath(path), base);
    url.hash = line ? `L${line}` : "";
    return insideBase(url, base);
  } catch {
    return undefined;
  }
};

/** URL of a local link (relative, root-relative or `#anchor`) found in the local file `page` */
const getLocalLinkUrl = (
  base: string | undefined,
  page: string,
  href: string,
): string | undefined => {
  if (!base) return undefined;
  try {
    const url = href.startsWith("/")
      ? new URL(href.replace(/^\/+/, ""), base)
      : new URL(href, new URL(encodePath(page), base));
    return insideBase(url, base);
  } catch {
    return undefined;
  }
};

/** Link text for display: site origin dropped, the #hash highlighted */
const LinkLabel = ({ href, siteOrigin }: { href: string; siteOrigin?: string }) => {
  const label = displayUrl(href, siteOrigin);
  const hashStart = label.indexOf("#");
  return hashStart < 0 ? (
    <>{label}</>
  ) : (
    <>
      {label.slice(0, hashStart)}
      <span class="hash">{label.slice(hashStart)}</span>
    </>
  );
};

/** Where the link cell links to: the link itself, its target file next to the checked file, or nowhere */
const getLinkCellUrl = (link: LinkWithResult, options: RenderOptions): string | undefined => {
  if (isHttpUrl(link.href)) {
    return link.href;
  }
  // A relative link on a web page has no known source file
  if (isHttpUrl(link.page)) {
    return undefined;
  }
  return getLocalLinkUrl(options.sourceBaseUrl, link.page, link.href);
};

type ViewProps = { options: RenderOptions; siteOrigin?: string };

const LinkCell = ({ link, options, siteOrigin }: ViewProps & { link: LinkWithResult }) => {
  const url = getLinkCellUrl(link, options);
  const label = <LinkLabel href={link.href} siteOrigin={siteOrigin} />;
  return url ? (
    <a href={url} target="_blank" rel="noopener">
      {label}
    </a>
  ) : (
    <span data-local-link="">{label}</span>
  );
};

/** Copied by the script in `renderReportToHTML`, no inline JS so any URL is safe */
const CopyButton = ({ href }: { href: string }) => (
  <button type="button" class="cp" data-copy-href={href} title="Copy link to clipboard">
    copy
  </button>
);

/** Short reason, redirect target and the raw error detail (only when it says more than the reason) */
const Reason = ({ link, siteOrigin }: ViewProps & { link: LinkWithResult | IgnoredLink }) => {
  const { result } = link;
  const reason = shortReason(link);
  const detail = result.ok ? "" : (result.errorDetail?.trim() ?? "");
  // The reason already says it unless a response body (markup) or a long text was cut off
  const hasMoreDetail = /[<\n]/.test(detail) || reason.endsWith("…");
  const redirect = result.redirectedTo;
  const redirectUrl = redirect ? safeHref(redirect) : undefined;
  return (
    <>
      {reason ? <div class="rs">{reason}</div> : null}
      {redirect ? (
        <div class="rs">
          → redirects to{" "}
          {redirectUrl ? (
            <a href={redirectUrl} target="_blank" rel="noopener">
              {displayUrl(redirect, siteOrigin)}
            </a>
          ) : (
            displayUrl(redirect, siteOrigin)
          )}
        </div>
      ) : null}
      {hasMoreDetail ? (
        <details>
          <summary>response body</summary>
          <pre>{detail}</pre>
        </details>
      ) : null}
    </>
  );
};

const Problem = ({ link }: { link: LinkWithResult }) => (
  <span class={problemKind(link) === "check" ? "warn" : "bad"}>{problemLabel(link)}</span>
);

/** A page of a link: `/path "link text"`, or `file:line` for local files */
const PageRef = ({ link, options, siteOrigin }: ViewProps & { link: Link }) => {
  const label = displayUrl(formatLocation(link), siteOrigin);
  const text = link.text ? <span class="txt">"{link.text}"</span> : null;
  if (isHttpUrl(link.page)) {
    return (
      <div class="pg">
        {/* https://developer.mozilla.org/en-US/docs/Web/URI/Fragment/Text_fragments */}
        <a
          href={safeHref(`${link.page}#:~:text=${encodeURIComponent(link.text)}`)}
          target="_blank"
          rel="noopener"
        >
          {label}
        </a>
        {text}
      </div>
    );
  }
  // Local file: link to the checked file if its URL is known, plain text otherwise
  const url = getLocalFileUrl(options.sourceBaseUrl, link.page, link.line);
  const code = <code>{label}</code>;
  return (
    <div class="pg">
      {url ? (
        <a href={url} target="_blank" rel="noopener">
          {code}
        </a>
      ) : (
        code
      )}
      {text}
    </div>
  );
};

const VISIBLE_PAGES = 3;

const PagesCell = ({ pages, ...view }: ViewProps & { pages: Link[] }) => (
  <>
    {pages.slice(0, VISIBLE_PAGES).map((page) => (
      <PageRef link={page} {...view} />
    ))}
    {pages.length > VISIBLE_PAGES ? (
      <details>
        <summary>+{pages.length - VISIBLE_PAGES} more</summary>
        {pages.slice(VISIBLE_PAGES).map((page) => (
          <PageRef link={page} {...view} />
        ))}
      </details>
    ) : null}
  </>
);

/** One row per target link, with the pages to fix it on. Ignored groups also show why they are ignored. */
const GroupRow = ({
  group,
  ignored,
  ...view
}: ViewProps & { group: TargetGroup<IgnoredLink>; ignored: boolean }) => (
  <tr data-row="" data-kind={problemKind(group.link)}>
    <td class="pb">
      <Problem link={group.link} />
    </td>
    <td class="lk">
      <LinkCell link={group.link} {...view} />
      <Reason link={group.link} {...view} />
    </td>
    <td>
      <PagesCell pages={group.pages} {...view} />
    </td>
    {/* Baseline reasons are optional, the cell is always there to keep the columns aligned */}
    {ignored ? <td class="rs">{group.link.ignoreReason ?? ""}</td> : null}
    <td>
      <CopyButton href={group.link.href} />
    </td>
  </tr>
);

const ByLinkTable = ({
  groups,
  ignored = false,
  ...view
}: ViewProps & { groups: TargetGroup<IgnoredLink>[]; ignored?: boolean }) => (
  <table>
    <thead>
      <tr>
        <th>Problem</th>
        <th>Link</th>
        <th>Pages</th>
        {ignored ? <th>Ignored because</th> : null}
        <th />
      </tr>
    </thead>
    <tbody>
      {groups.map((group) => (
        <GroupRow group={group} ignored={ignored} {...view} />
      ))}
    </tbody>
  </table>
);

const groupByPage = (links: LinkWithResult[]): Map<string, LinkWithResult[]> => {
  const pages = new Map<string, LinkWithResult[]>();
  for (const link of links) {
    const pageLinks = pages.get(link.page);
    if (pageLinks) {
      pageLinks.push(link);
    } else {
      pages.set(link.page, [link]);
    }
  }
  return pages;
};

/** Links grouped by the page they are on (a page is a heading row, its links follow) */
const ByPageTable = ({ links, ...view }: ViewProps & { links: LinkWithResult[] }) => {
  // The line column is only for local files
  const hasLines = links.some((link) => link.line);
  return (
    <table>
      <thead>
        <tr>
          {hasLines ? <th>Line</th> : null}
          <th>Problem</th>
          <th>Link</th>
          <th>Reason</th>
        </tr>
      </thead>
      {[...groupByPage(links)].map(([page, pageLinks]) => {
        const url = isHttpUrl(page)
          ? safeHref(page)
          : getLocalFileUrl(view.options.sourceBaseUrl, page);
        const name = displayUrl(page, view.siteOrigin);
        return (
          <tbody data-page={page}>
            <tr class="ph">
              <td colSpan={hasLines ? 4 : 3}>
                {url ? (
                  <a href={url} target="_blank" rel="noopener">
                    {name}
                  </a>
                ) : (
                  name
                )}{" "}
                <span class="muted">{pageLinks.length}</span>
              </td>
            </tr>
            {pageLinks.map((link) => (
              <tr data-row="" data-kind={problemKind(link)} data-page={page}>
                {hasLines ? <td class="mono muted">{link.line ? `:${link.line}` : ""}</td> : null}
                <td class="pb">
                  <Problem link={link} />
                </td>
                <td class="lk">
                  <LinkCell link={link} {...view} />
                  {link.text ? <span class="txt">"{link.text}"</span> : null}{" "}
                  <CopyButton href={link.href} />
                </td>
                <td>
                  <Reason link={link} {...view} />
                </td>
              </tr>
            ))}
          </tbody>
        );
      })}
    </table>
  );
};

const formatDuration = (ms: number): string => {
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  // Round once, then split: rounding the seconds alone turns 119.9s into `1m 0s`
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const Sep = () => <span class="sep">·</span>;

const Stats = ({ report }: { report: LinkCheckReport }) => {
  const { summary } = report;
  const counts = countByKind([...getLinksToFix(report), ...report.couldNotCheck]);
  const filters = [
    ["broken", counts.broken, "broken"],
    ["anchor", counts.anchor, "anchor"],
    ["network", counts.network, "network error"],
    ["check", counts.check, "could not check"],
  ] as const;
  return (
    <p class="stats">
      {filters
        .filter(([kind, count]) => count > 0 || kind !== "network")
        .map(([kind, count, label]) => (
          <>
            <button type="button" data-kind-filter={kind} aria-pressed="false">
              {count} {label}
            </button>
            <Sep />
          </>
        ))}
      {summary.ignored > 0 ? (
        <a href="#ignored">{summary.ignored} ignored</a>
      ) : (
        <span class="muted">0 ignored</span>
      )}
      <Sep />
      {summary.linksChecked.toLocaleString("en-US")} checked
    </p>
  );
};

const JSONReportRenderer = ({
  report,
  options,
}: {
  report: LinkCheckReport;
  options: RenderOptions;
}) => {
  const { summary } = report;
  const toFix = getLinksToFix(report);
  const all = [...toFix, ...report.couldNotCheck];
  // The checked site: pages are shown without its origin
  const siteOrigin = findSiteOrigin([...all, ...report.ignored]);
  const view: ViewProps = { options, ...(siteOrigin ? { siteOrigin } : {}) };
  const ignoredGroups = groupByTarget(report.ignored);
  // Links to fix first, then those that could not be checked
  const groups = [...groupByTarget(toFix), ...groupByTarget(report.couldNotCheck)];
  const failed = summary.totalLinksToFix > 0;
  return (
    <>
      <header>
        <h1>
          {report.siteName}{" "}
          <span class={failed ? "bad" : "ok"}>
            {failed ? `${summary.totalLinksToFix} to fix` : "✓ OK"}
          </span>
        </h1>
        <Stats report={report} />
        <p class="muted">
          {report.generatedAt.slice(0, 16).replace("T", " ")} UTC
          <Sep />
          {formatDuration(report.durationMs)}
          {report.diff ? (
            <>
              <Sep />+{report.diff.new} new, {report.diff.fixed} fixed
            </>
          ) : null}
          <Sep />
          <a href={basename(getReportPaths(report.siteName).json)}>JSON</a>
        </p>
      </header>

      {all.length > 0 ? (
        <>
          <div class="bar" id="bar" hidden>
            <input
              type="search"
              id="q"
              aria-label="Filter links"
              placeholder="Filter by URL, page or text"
            />
            <span class="view">
              <button type="button" data-view="link" aria-pressed="true">
                By link
              </button>
              <Sep />
              <button type="button" data-view="page" aria-pressed="false">
                By page
              </button>
            </span>
            <span class="muted" id="count" />
          </div>
          <main>
            <div id="by-link">
              <ByLinkTable groups={groups} {...view} />
            </div>
            <div id="by-page" hidden>
              <ByPageTable links={all} {...view} />
            </div>
          </main>
        </>
      ) : (
        <p class="ok">
          ✓ All {summary.linksChecked.toLocaleString("en-US")}{" "}
          {summary.linksChecked === 1 ? "link" : "links"} OK
        </p>
      )}

      {ignoredGroups.length > 0 ? (
        <section>
          <details id="ignored" data-section="ignored">
            <summary>
              {summary.ignored} ignored by baseline ({ignoredGroups.length}{" "}
              {ignoredGroups.length === 1 ? "link" : "links"})
            </summary>
            <ByLinkTable groups={ignoredGroups} ignored {...view} />
          </details>
        </section>
      ) : null}
    </>
  );
};

/**
 * Renders the report as a full HTML page. All dynamic values are escaped by Preact.
 */
export function renderReportToHTML(
  jsonReport: LinkCheckReport,
  options: RenderOptions = {},
): string {
  const { siteName, summary } = jsonReport;
  const status = summary.totalLinksToFix > 0 ? `✗ ${summary.totalLinksToFix} to fix` : "✓ OK";
  const title = renderToStaticMarkup(<title>{`${status} · ${siteName}`}</title>);
  const body = renderToStaticMarkup(<JSONReportRenderer report={jsonReport} options={options} />);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${title}
<style>${REPORT_CSS}</style>
</head>
<body>
${body}
<script>${REPORT_SCRIPT}</script>
</body>
</html>
`;
}

function renderReportToHTMLFile(
  jsonReport: LinkCheckReport,
  filePath: string,
  options: RenderOptions = {},
) {
  writeFileSync(filePath, renderReportToHTML(jsonReport, options));
}

export const DEFAULT_OUTPUT_DIR = "results";

/** Paths of the JSON and HTML reports of a site (`docs.fingerprint.com` -> `results/docs-fingerprint-com.json`) */
export const getReportPaths = (siteName: string, outputDir = DEFAULT_OUTPUT_DIR) => {
  const normalizedSitename = siteName.replace(/\W/g, "-").toLowerCase();
  return {
    json: join(outputDir, `${normalizedSitename}.json`),
    html: join(outputDir, `${normalizedSitename}.html`),
  };
};

/**
 * Saves the report as JSON and HTML into `outputDir` (created if needed).
 * @returns the paths of the saved reports
 */
export function saveReport(
  report: LinkCheckReport,
  outputDir = DEFAULT_OUTPUT_DIR,
  options: RenderOptions = {},
) {
  const paths = getReportPaths(report.siteName, outputDir);
  mkdirSync(outputDir, { recursive: true });

  writeFileSync(paths.json, JSON.stringify(report, null, 2));

  renderReportToHTMLFile(report, paths.html, options);
  return paths;
}
