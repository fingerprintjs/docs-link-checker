import { writeFileSync } from "node:fs";
import type { PromisePoolError } from "@supercharge/promise-pool";
import { renderToStaticMarkup } from "react-dom/server";
import type { Link, LinkWithResult } from "../types";

type LinkCheckReport = ReturnType<typeof getJSONReport>;

type GetReportArgs = {
  links: LinkWithResult[];
  errors: PromisePoolError<Link>[];
  siteName: string;
};

export const getJSONReport = ({ links, errors, siteName }: GetReportArgs) => {
  const brokenLinks = links.filter(
    (link) => link.result.ok === false && link.result.error === "broken link",
  );
  const hashNotFound = links.filter(
    (link) => link.result.ok === false && link.result.error === "hash not found",
  );
  const couldNotCheck = links.filter(
    (link) => link.result.ok === false && link.result.error === "could not check",
  );
  const unexpectedErrors = [
    ...links.filter((link) => link.result.ok === false && link.result.error === "unexpected error"),
    ...errors.map(
      (error) =>
        ({
          ...error.item,
          result: { ok: false, error: "unexpected error", errorDetail: error.message, status: 0 },
        }) satisfies LinkWithResult,
    ),
  ];

  return {
    siteName,
    summary: {
      linksChecked: links.length,
      totalLinksToFix: brokenLinks.length + hashNotFound.length + unexpectedErrors.length,
      brokenLinks: brokenLinks.length,
      hashNotFound: hashNotFound.length,
      networkErrors: unexpectedErrors.length,
      couldNotCheck: couldNotCheck.length,
    },
    brokenLinks,
    hashNotFound,
    networkErrors: unexpectedErrors,
    couldNotCheck,
  };
};

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

const JSONReportRenderer = ({ report }: { report: LinkCheckReport }) => {
  const allBrokenLinks = [
    ...report.brokenLinks,
    ...report.hashNotFound,
    ...report.networkErrors,
    ...report.couldNotCheck,
  ];
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
        </ul>
      </div>

      <table className="border-collapse border border-gray-300">
        <thead>
          <tr className="bg-gray-100">
            <th className="py-2 px-4 border-b text-left">Page</th>
            <th className="py-2 px-4 border-b text-left">Link</th>
            <th className="py-2 px-4 border-b text-left">Result</th>
          </tr>
        </thead>
        <tbody>
          {allBrokenLinks.map((link, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rendered once to static HTML, rows are never reordered, and the same link can appear twice
            <tr key={index} className={index % 2 === 0 ? "bg-gray-50" : "bg-white"}>
              <td className="py-2 px-4 border-b break-all sm:break-words">
                {/* https://developer.mozilla.org/en-US/docs/Web/URI/Fragment/Text_fragments */}📄{" "}
                <a
                  href={safeHref(`${link.page}#:~:text=${encodeURIComponent(link.text)}`)}
                  target="_blank"
                  rel="noopener"
                >
                  {link.page}
                </a>
              </td>
              <td className="py-2 px-4 border-b break-all sm:break-words">
                <a href={safeHref(link.href)} target="_blank" rel="noopener">
                  🔗"{link.text}" ➡️ <HrefRenderer link={link} />
                </a>
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
                {link.result.ok ? (
                  <span className="text-green-600">OK</span>
                ) : (
                  <span className="text-red-600">
                    {link.result.error === "broken link" && "🔴 "}
                    {link.result.error === "hash not found" && "#️⃣ "}
                    {link.result.error === "could not check" && "⚠️ "}
                    {link.result.error === "unexpected error" && "❌ "}
                    {link.result.error}
                    {link.result.status ? ` (Status: ${link.result.status})` : null}
                    {link.result.errorDetail ? (
                      <details>
                        <summary>Error detail</summary>
                        <pre>{link.result.errorDetail}</pre>
                      </details>
                    ) : null}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
 * Renders the report as a full HTML page. All dynamic values are escaped by React.
 */
export function renderReportToHTML(jsonReport: LinkCheckReport): string {
  const htmlString = renderToStaticMarkup(<JSONReportRenderer report={jsonReport} />);
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

export function renderReportToHTMLFile(jsonReport: LinkCheckReport, filePath: string) {
  writeFileSync(filePath, renderReportToHTML(jsonReport));
}

export function saveReport(report: LinkCheckReport) {
  const normalizedSitename = report.siteName.replace(/\W/g, "-").toLowerCase();
  const jsonFilename = `./results/${normalizedSitename}.json`;
  const htmlFilename = `./results/${normalizedSitename}.html`;

  writeFileSync(jsonFilename, JSON.stringify(report, null, 2));
  console.log(`Saved JSON report to ${jsonFilename}`);

  renderReportToHTMLFile(report, htmlFilename);
  console.log(`Saved HTML report to ${htmlFilename}`);
}
