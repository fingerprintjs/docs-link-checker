/**
 * Inline CSS and script of the HTML report. The report is one self-contained file: no CDN, no external requests,
 * so it works offline and as a downloaded CI artifact.
 */

export const REPORT_CSS = `
:root{color-scheme:light dark;--fg:#1f2328;--muted:#6b7280;--line:#e5e7eb;--bg:#fff;--bad:#c62828;--ok:#1a7f37;--warn:#9a6700;--hash:#b35900;--hover:#f6f8fa}
@media(prefers-color-scheme:dark){:root{--fg:#d8dee4;--muted:#8b949e;--line:#30363d;--bg:#0d1117;--bad:#ff7b72;--ok:#56d364;--warn:#e3b341;--hash:#f0883e;--hover:#161b22}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:6px auto;padding:0 10px;max-width:1400px;font:13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:2px}
a:hover{text-decoration-color:currentColor}
h1{margin:0;font-size:15px;font-weight:600}
p{margin:2px 0}
.muted,.txt{color:var(--muted)}
.bad{color:var(--bad)}.ok{color:var(--ok)}.warn{color:var(--warn)}
.stats button,.view button,.cp,summary{font:inherit;color:inherit}
button{background:none;border:0;padding:0;cursor:pointer}
.stats button{text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:2px}
button[aria-pressed=true]{font-weight:600;text-decoration-color:currentColor}
.sep{color:var(--muted);margin:0 4px}
.bar{display:flex;gap:12px;align-items:center;margin:6px 0;padding:4px 0;border-bottom:1px solid var(--line)}
.bar input{flex:1;max-width:420px;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:2px 6px}
.view button{padding:0 2px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-weight:400;color:var(--muted);padding:2px 10px 2px 0;white-space:nowrap}
td{padding:2px 10px 2px 0;vertical-align:top;border-top:1px solid var(--line)}
tbody:first-of-type tr:first-child td{border-top:0}
tr:hover td{background:var(--hover)}
.pb{white-space:nowrap}
.lk,.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.lk{word-break:break-all}
.hash{color:var(--hash)}
.rs{color:var(--muted);font-size:12px}
.pg{overflow-wrap:anywhere}
.txt{display:inline-block;margin-left:4px;max-width:32ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.ph td{font-weight:600;border-top:1px solid var(--line);padding-top:6px}
.cp{color:var(--muted);font-size:12px;white-space:nowrap}
.cp:hover{color:var(--fg)}
details{display:block}
summary{cursor:pointer;color:var(--muted);display:inline-block}
details[open]>summary{margin-bottom:2px}
pre{margin:2px 0;padding:4px 6px;max-height:12em;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px;border:1px solid var(--line)}
section{margin-top:12px}
@media(max-width:700px){
body{margin:4px auto;padding:0 6px}
thead{display:none}
tr,td{display:block}
tr{position:relative;border-top:1px solid var(--line);padding:3px 0}
td:last-child:has(.cp){position:absolute;top:3px;right:0}
td,tbody:first-of-type tr:first-child td{border:0;padding:0}
.ph{border-top:1px solid var(--line)}
}
`;

// Client-side search and filters only. The page is readable without it (the toolbar stays hidden).
export const REPORT_SCRIPT = `
(function () {
  var q = "", kind = "", view = "link";
  var bar = document.getElementById("bar");
  var rows = Array.prototype.slice.call(document.querySelectorAll("[data-row]"));
  var pages = Array.prototype.slice.call(document.querySelectorAll("tbody[data-page]"));
  var count = document.getElementById("count");
  function apply() {
    var shown = 0;
    rows.forEach(function (row) {
      var match = (!kind || row.getAttribute("data-kind") === kind) &&
        (!q || ((row.textContent || "") + " " + (row.getAttribute("data-page") || "")).toLowerCase().indexOf(q) >= 0);
      row.hidden = !match;
      if (match && !row.closest("[data-section=ignored]") && !row.closest("tbody[data-page]")) shown++;
    });
    pages.forEach(function (tbody) {
      tbody.hidden = !tbody.querySelector("[data-row]:not([hidden])");
    });
    if (count) count.textContent = q || kind ? shown + " shown" : "";
    // An all-OK report has no tables, only the filter buttons
    var byLink = document.getElementById("by-link"), byPage = document.getElementById("by-page");
    if (byLink) byLink.hidden = view !== "link";
    if (byPage) byPage.hidden = view !== "page";
    document.querySelectorAll("[data-view]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-view") === view));
    });
    document.querySelectorAll("[data-kind-filter]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-kind-filter") === kind));
    });
  }
  function openIgnored() {
    var ignored = document.getElementById("ignored");
    if (ignored) ignored.open = true;
  }
  if (bar) bar.hidden = false;
  document.addEventListener("input", function (event) {
    if (event.target && event.target.id === "q") { q = event.target.value.toLowerCase(); apply(); }
  });
  document.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    var copy = target.closest("[data-copy-href]");
    if (copy) {
      var label = copy.getAttribute("data-label") || copy.textContent;
      copy.setAttribute("data-label", label);
      var show = function (text) {
        copy.textContent = text;
        setTimeout(function () { copy.textContent = label; }, 1200);
      };
      // No Clipboard API or a denied write (e.g. a report opened from a file): say so instead of "Copied"
      if (!navigator.clipboard) { show("Copy failed"); return; }
      navigator.clipboard.writeText(copy.getAttribute("data-copy-href") || "").then(
        function () { show("Copied"); },
        function () { show("Copy failed"); }
      );
      return;
    }
    var filter = target.closest("[data-kind-filter]");
    if (filter) {
      var value = filter.getAttribute("data-kind-filter");
      kind = kind === value ? "" : value;
      apply();
      return;
    }
    var toggle = target.closest("[data-view]");
    if (toggle) { view = toggle.getAttribute("data-view"); apply(); return; }
    if (target.closest("a[href='#ignored']")) openIgnored();
  });
  if (location.hash === "#ignored") openIgnored();
})();
`;
