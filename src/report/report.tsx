/** @jsx h */
/** @jsxFrag Fragment */
// npx/tsx defaults to React.createElement unless the factory is in this file.
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
// oxlint-disable-next-line eslint/no-unused-vars -- Fragment is used via @jsxFrag / tsconfig jsxFragmentFactory
import { Fragment, h } from "preact";
import { renderToStaticMarkup } from "preact-render-to-string";
import { type Baseline, EMPTY_BASELINE } from "../baseline";
import type { Link, LinkWithResult } from "../types";

export type LinkCheckReport = ReturnType<typeof getJSONReport>;

/** A failing link that matched an entry of the baseline file */
type IgnoredLink = LinkWithResult & { ignoreReason?: string };

type GetReportArgs = {
  links: LinkWithResult[];
  siteName: string;
  /** Failing links matching the baseline are moved to `ignored` and don't count towards `totalLinksToFix` */
  baseline?: Baseline;
};

export const getJSONReport = ({ links, siteName, baseline = EMPTY_BASELINE }: GetReportArgs) => {
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

  return {
    siteName,
    summary: {
      linksChecked: links.length,
      totalLinksToFix: brokenLinks.length + hashNotFound.length + unexpectedErrors.length,
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

const isHttpUrl = (value: string) => safeHref(value) !== undefined;

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

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

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

const HrefRenderer = ({ link }: { link: LinkWithResult }) => {
  const { href, result } = link;

  if (result.ok) {
    return href;
  }

  if (result.error === "hash not found") {
    const [baseUrl, hash] = href.split("#");
    return (
      <span>
        {baseUrl}
        <span className="text-red-600">#{hash}</span>
      </span>
    );
  }

  return <span className="text-red-600">{href}</span>;
};

const pageLabel = (link: Link) => (link.line ? `${link.page}:${link.line}` : link.page);

const ResultRenderer = ({ link }: { link: LinkWithResult | IgnoredLink }) =>
  link.result.ok ? (
    <span className="text-green-600">OK</span>
  ) : (
    <span className="text-red-600">
      {link.result.error === "broken link" && "🔴 "}
      {link.result.error === "hash not found" && "#️⃣ "}
      {link.result.error === "could not check" && "⚠️ "}
      {link.result.error === "unexpected error" && "❌ "}
      {link.result.error}
      {link.result.status ? ` (Status: ${link.result.status})` : null}
      {"ignoreReason" in link && link.ignoreReason ? (
        <div className="text-gray-600">Ignored: {link.ignoreReason}</div>
      ) : null}
      {link.result.errorDetail ? (
        <details>
          <summary>Error detail</summary>
          <pre>{link.result.errorDetail}</pre>
        </details>
      ) : null}
    </span>
  );

const PageCell = ({ link, options }: { link: Link; options: RenderOptions }) => {
  if (isHttpUrl(link.page)) {
    return (
      <>
        {/* https://developer.mozilla.org/en-US/docs/Web/URI/Fragment/Text_fragments */}📄{" "}
        <a
          href={safeHref(`${link.page}#:~:text=${encodeURIComponent(link.text)}`)}
          target="_blank"
          rel="noopener"
        >
          {pageLabel(link)}
        </a>
      </>
    );
  }
  // Local file: link to the checked file if its URL is known, plain text otherwise
  const url = getLocalFileUrl(options.sourceBaseUrl, link.page, link.line);
  const label = <code>{pageLabel(link)}</code>;
  return (
    <>
      📄{" "}
      {url ? (
        <a href={url} target="_blank" rel="noopener">
          {label}
        </a>
      ) : (
        label
      )}
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

const LinkCell = ({
  link,
  options,
  showText = true,
}: {
  link: LinkWithResult;
  options: RenderOptions;
  /** False when occurrences of this URL use different anchor texts (those are shown next to each page) */
  showText?: boolean;
}) => {
  const content = showText ? (
    <>
      🔗"{link.text}" ➡️ <HrefRenderer link={link} />
    </>
  ) : (
    <>
      🔗 <HrefRenderer link={link} />
    </>
  );
  const url = getLinkCellUrl(link, options);
  return url ? (
    <a href={url} target="_blank" rel="noopener">
      {content}
    </a>
  ) : (
    <span data-local-link="">{isHttpUrl(link.href) ? content : <code>{content}</code>}</span>
  );
};

const LinksTable = ({
  links,
  options,
}: {
  links: Array<LinkWithResult | IgnoredLink>;
  options: RenderOptions;
}) => (
  <table className="border-collapse border border-gray-300 mb-6">
    <thead>
      <tr className="bg-gray-100">
        <th className="py-2 px-4 border-b text-left">Page</th>
        <th className="py-2 px-4 border-b text-left">Link</th>
        <th className="py-2 px-4 border-b text-left">Result</th>
      </tr>
    </thead>
    <tbody>
      {links.map((link, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- rendered once to static HTML, rows are never reordered, and the same link can appear twice
        <tr key={index} className={index % 2 === 0 ? "bg-gray-50" : "bg-white"}>
          <td className="py-2 px-4 border-b break-all sm:break-words">
            <PageCell link={link} options={options} />
          </td>
          <td className="py-2 px-4 border-b break-all sm:break-words">
            <LinkCell link={link} options={options} />
            {/* Copied by the script in `renderReportToHTML`, no inline JS so any URL is safe */}
            <button
              type="button"
              data-copy-href={link.href}
              className="ml-2 hover:bg-gray-200 rounded p-1"
              title="Copy link to clipboard"
            >
              📋
            </button>
          </td>

          <td className="py-2 px-4 border-b">
            <ResultRenderer link={link} />
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

type IgnoredGroup = {
  /** First occurrence. Its result and reason represent the group. */
  link: IgnoredLink;
  occurrences: IgnoredLink[];
};

const LOCAL_LINK_BASE = "https://local.invalid/";

/**
 * What the ignored link points at.
 * An http(s) href is itself. Anything else is resolved against the page it was found on, the same way
 * `checkLocalLink` resolves it: `missing.md` in `a/README.md` and `b/README.md` are different files.
 */
const ignoredTargetKey = (link: { href: string; page: string }): string => {
  if (isHttpUrl(link.href)) {
    return link.href;
  }
  try {
    if (isHttpUrl(link.page)) {
      return new URL(link.href, link.page).href;
    }
    const url = link.href.startsWith("/")
      ? new URL(link.href.replace(/^\/+/, ""), LOCAL_LINK_BASE)
      : new URL(link.href, new URL(encodePath(link.page), LOCAL_LINK_BASE));
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return JSON.stringify([link.page, link.href]);
  }
};

const ignoredGroupKey = (link: IgnoredLink): string =>
  JSON.stringify([
    ignoredTargetKey(link),
    link.result.ok ? "ok" : link.result.error,
    link.result.ok ? "" : (link.result.status ?? ""),
    link.ignoreReason ?? "",
  ]);

// One row per target, error, status, and ignore reason.
// errorDetail stays out of the key. A Cloudflare challenge page changes on every request, so it would split the group into one row per page.
const groupIgnoredLinks = (links: IgnoredLink[]): IgnoredGroup[] => {
  const groups = new Map<string, IgnoredGroup>();
  for (const link of links) {
    const key = ignoredGroupKey(link);
    const group = groups.get(key);
    if (group) {
      group.occurrences.push(link);
    } else {
      groups.set(key, { link, occurrences: [link] });
    }
  }
  return [...groups.values()];
};

const IgnoredPages = ({
  links,
  options,
  showText,
}: {
  links: IgnoredLink[];
  options: RenderOptions;
  showText: boolean;
}) => {
  const page = (link: IgnoredLink) => (
    <>
      <PageCell link={link} options={options} />
      {showText ? <> 🔗"{link.text}"</> : null}
    </>
  );
  const only = links[0];
  if (links.length === 1 && only) {
    return page(only);
  }
  return (
    <details>
      <summary>{links.length} occurrences</summary>
      <ul className="list-disc pl-5 mt-2">
        {links.map((link, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- rendered once to static HTML, rows are never reordered, and the same link can appear twice
          <li key={index}>{page(link)}</li>
        ))}
      </ul>
    </details>
  );
};

const IgnoredLinksTable = ({
  groups,
  options,
}: {
  groups: IgnoredGroup[];
  options: RenderOptions;
}) => (
  <table className="border-collapse border border-gray-300 mb-6">
    <thead>
      <tr className="bg-gray-100">
        <th className="py-2 px-4 border-b text-left">Link</th>
        <th className="py-2 px-4 border-b text-left">Result</th>
        <th className="py-2 px-4 border-b text-left">Pages</th>
      </tr>
    </thead>
    <tbody>
      {groups.map((group, index) => {
        const sameText = group.occurrences.every((item) => item.text === group.link.text);
        return (
          // oxlint-disable-next-line react/no-array-index-key -- rendered once to static HTML, rows are never reordered, and the same link can appear twice
          <tr key={index} className={index % 2 === 0 ? "bg-gray-50" : "bg-white"}>
            <td className="py-2 px-4 border-b break-all sm:break-words">
              <LinkCell link={group.link} options={options} showText={sameText} />
              <button
                type="button"
                data-copy-href={group.link.href}
                className="ml-2 hover:bg-gray-200 rounded p-1"
                title="Copy link to clipboard"
              >
                📋
              </button>
            </td>
            <td className="py-2 px-4 border-b">
              <ResultRenderer link={group.link} />
            </td>
            <td className="py-2 px-4 border-b break-all sm:break-words">
              <IgnoredPages links={group.occurrences} options={options} showText={!sameText} />
            </td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

const JSONReportRenderer = ({
  report,
  options,
}: {
  report: LinkCheckReport;
  options: RenderOptions;
}) => {
  const allBrokenLinks = [
    ...report.brokenLinks,
    ...report.hashNotFound,
    ...report.networkErrors,
    ...report.couldNotCheck,
  ];
  const ignoredGroups = groupIgnoredLinks(report.ignored);
  const uniqueIgnoredLinks = new Set(report.ignored.map((link) => ignoredTargetKey(link))).size;
  return (
    <div className="overflow-x-auto min-w-[720px] max-w-[1280px] mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Link Check Report for {report.siteName}</h1>

      <div className="bg-gray-100 p-4 rounded-lg mb-6">
        <h2 className="text-xl font-semibold mb-3">Summary</h2>
        <ul className="list-disc pl-5">
          <li>Links checked: {report.summary.linksChecked}</li>
          <li>Total links to fix: {report.summary.totalLinksToFix}</li>
          <li>Broken links: {report.summary.brokenLinks}</li>
          <li>Hash not found: {report.summary.hashNotFound}</li>
          <li>Network errors: {report.summary.networkErrors}</li>
          <li>Could not check: {report.summary.couldNotCheck}</li>
          <li>Ignored (baseline): {report.summary.ignored}</li>
        </ul>
      </div>

      <LinksTable links={allBrokenLinks} options={options} />

      {ignoredGroups.length > 0 ? (
        <section data-section="ignored">
          <h2 className="text-xl font-semibold mb-3">Ignored (matched the baseline file)</h2>
          {uniqueIgnoredLinks < report.ignored.length ? (
            <p className="mb-3 text-gray-600">
              {uniqueIgnoredLinks} unique {uniqueIgnoredLinks === 1 ? "link" : "links"} (
              {report.ignored.length} occurrences)
            </p>
          ) : null}
          <IgnoredLinksTable groups={ignoredGroups} options={options} />
        </section>
      ) : null}
    </div>
  );
};

// Copies the link from the `data-copy-href` attribute of the clicked copy button
const COPY_LINK_SCRIPT = `
document.addEventListener("click", function (event) {
  var button = event.target instanceof Element ? event.target.closest("[data-copy-href]") : null;
  if (button) {
    navigator.clipboard.writeText(button.getAttribute("data-copy-href") || "");
  }
});
`;

/**
 * Renders the report as a full HTML page. All dynamic values are escaped by Preact.
 */
export function renderReportToHTML(
  jsonReport: LinkCheckReport,
  options: RenderOptions = {},
): string {
  const htmlString = renderToStaticMarkup(
    <JSONReportRenderer report={jsonReport} options={options} />,
  );
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Link Check Report</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body>
        <div id="root">${htmlString}</div>
        <script>${COPY_LINK_SCRIPT}</script>
      </body>
    </html>
  `;
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
export const saveReport = (
  report: LinkCheckReport,
  outputDir = DEFAULT_OUTPUT_DIR,
  options: RenderOptions = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = getReportPaths(report.siteName, outputDir);
    yield* fs.makeDirectory(outputDir, { recursive: true });

    yield* fs.writeFileString(paths.json, JSON.stringify(report, null, 2));
    yield* Effect.logInfo(`Saved JSON report to ${paths.json}`);

    yield* fs.writeFileString(paths.html, renderReportToHTML(report, options));
    yield* Effect.logInfo(`Saved HTML report to ${paths.html}`);
    return paths;
  });
