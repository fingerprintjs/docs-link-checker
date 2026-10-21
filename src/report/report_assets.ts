/**
 * Inline CSS and script of the HTML report. The report is one self-contained file: no CDN, no external requests,
 * so it works offline and as a downloaded CI artifact.
 */

export const REPORT_CSS = `
:root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--line:#d8dee4;--ctl:#8c959f;--bg:#fff;--hover:#f6f8fa;--bad:#c62828;--warn:#9a6700;--ok:#1a7f37;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media(prefers-color-scheme:dark){:root{--fg:#d8dee4;--muted:#9198a1;--line:#30363d;--ctl:#6e7681;--bg:#0d1117;--hover:#161b22;--bad:#ff7b72;--warn:#e3b341;--ok:#56d364}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:6px auto;padding:0 10px;max-width:1400px;font:13px/1.35 var(--sans);color:var(--fg);background:var(--bg)}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:2px}
a:hover{text-decoration-color:currentColor}
h1{margin:0;font-size:15px;font-weight:600}
p{margin:2px 0}
.muted,.txt{color:var(--muted)}
.bad{color:var(--bad)}.ok{color:var(--ok)}
.g{margin-right:4px}.g.broken,.g.network{color:var(--bad)}.g.anchor{color:var(--warn)}.g.check{color:var(--muted)}
a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible{outline:2px solid currentColor;outline-offset:1px}
.stats button,.view button,.cp{font:inherit;color:inherit}
button{background:none;border:0;padding:0;cursor:pointer}
.stats button{text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:2px}
button[aria-pressed=true]{font-weight:600;text-decoration-color:currentColor}
.sep{color:var(--muted);margin:0 4px}
.bar{display:flex;gap:12px;align-items:center;margin:6px 0;padding:4px 0;border-bottom:1px solid var(--line)}
.bar input{flex:1;max-width:420px;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--ctl);border-radius:3px;padding:2px 6px}
.view button{padding:0 2px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-weight:400;color:var(--muted);padding:2px 10px 2px 0;white-space:nowrap}
td{padding:2px 10px 2px 0;vertical-align:top;border-top:1px solid var(--line)}
tbody:first-of-type tr:first-child td{border-top:0}
tr:hover td{background:var(--hover)}
.pb{white-space:nowrap}
.lk,.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.lk{word-break:break-all}
.hash{color:var(--warn)}
.rs{color:var(--muted);font:12px var(--sans)}
.pg{overflow-wrap:anywhere}
.txt{display:inline-block;margin-left:4px;max-width:32ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.ph td{font-weight:600;border-top:1px solid var(--line);padding-top:6px}
.cp{color:var(--muted);font:12px var(--sans);white-space:nowrap;vertical-align:middle;line-height:1;padding:1px 3px;border-radius:3px}
.cp:hover{color:var(--fg);background:var(--line)}
.cp svg{display:block}
.cr{white-space:nowrap}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
details{display:block}
summary{cursor:pointer;color:var(--muted);display:inline-block;font:12px var(--sans)}
details[open]>summary{margin-bottom:2px}
pre{margin:2px 0;padding:4px 6px;max-height:12em;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:12px;border:1px solid var(--line)}
section{margin-top:12px}
@media(max-width:700px){
body{margin:4px auto;padding:0 6px}
thead{display:none}
tr,td{display:block}
tr{position:relative;border-top:1px solid var(--line);padding:3px 0}
td.cr{position:absolute;top:3px;right:0}
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
    var copy = target.closest("[data-copy]");
    if (copy) {
      if (copy.original === undefined) copy.original = copy.innerHTML;
      var status = document.getElementById("copy-status");
      var show = function (glyph, message) {
        copy.textContent = glyph;
        if (status) status.textContent = message;
        setTimeout(function () { copy.innerHTML = copy.original; }, 1200);
      };
      // No Clipboard API or a denied write (e.g. a report opened from a file): say so instead of "Copied"
      if (!navigator.clipboard) { show("✗", "Copy failed"); return; }
      navigator.clipboard.writeText(copy.getAttribute("data-copy") || "").then(
        function () { show("✓", "Copied"); },
        function () { show("✗", "Copy failed"); }
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
