// MCP Apps view (ui://slipway/plan): a self-contained plan card. It speaks the MCP Apps postMessage protocol
// directly (ui/initialize -> tool-result notifications) and builds the DOM with text nodes only.
export const PLAN_CARD_URI = "ui://slipway/plan";

export const PLAN_CARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Slipway plan</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1c19;--muted:#6f6b62;--line:#e4e0d6;--card:#ffffff;--allow:#1f7a4d;--hold:#a86a00;--refuse:#b3261e;--band:#d9d3c4;--mark:#1d1c19;--chip:#f1ede4}
@media (prefers-color-scheme:dark){:root{--bg:#161512;--fg:#ece8df;--muted:#9c978b;--line:#2c2a25;--card:#1d1c19;--allow:#5cc28d;--hold:#e0a43a;--refuse:#f0786f;--band:#3a372f;--mark:#ece8df;--chip:#26241f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{padding:14px 16px;max-width:760px}
h1{font-size:15px;margin:0 0 2px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:16px 0 6px;font-weight:600}
.sub{color:var(--muted)}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.badge{font-weight:700;padding:2px 8px;border-radius:999px;border:1px solid currentColor;font-size:12px}
.allow{color:var(--allow)}.hold{color:var(--hold)}.refuse{color:var(--refuse)}
table{width:100%;border-collapse:collapse}td,th{padding:5px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12px}
.num{font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
.bandcell{width:34%}.bandbox{position:relative;height:14px}.bandbar{position:absolute;top:5px;height:4px;background:var(--band);border-radius:2px}.bandmark{position:absolute;top:1px;width:2px;height:12px;background:var(--mark)}
.chosen td{font-weight:600}.fix{color:var(--muted);margin-top:2px}
code{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--chip);padding:1px 4px;border-radius:4px;word-break:break-all}
.empty{color:var(--muted);padding:20px 0}
</style>
</head>
<body>
<main id="root"><div class="empty">Waiting for a Slipway plan…</div></main>
<script>
(function () {
  "use strict";
  var root = document.getElementById("root");
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.appendChild(document.createTextNode(String(text)));
    return e;
  }
  function add(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
  function bp(x) { return typeof x === "number" && isFinite(x) ? x.toFixed(1) + " bp" : "–"; }
  function usd(x) { return typeof x === "number" && isFinite(x) ? "$" + Math.round(x).toLocaleString("en-US") : "–"; }
  function qty(x) { return typeof x === "number" && isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "–"; }

  function bandTable(rows, chosenId) {
    var lo = Infinity, hi = -Infinity;
    rows.forEach(function (q) { lo = Math.min(lo, q.p10Bps); hi = Math.max(hi, q.p90Bps); });
    if (!(hi > lo)) { hi = lo + 1; }
    var t = el("table");
    var h = el("tr");
    ["Strategy", "Expected", "p10 – p90", "Cost", ""].forEach(function (c, i) { add(h, el("th", i > 0 && i < 4 ? "num" : "", c)); });
    add(t, h);
    rows.forEach(function (q) {
      var tr = el("tr", q.id === chosenId ? "chosen" : "");
      var name = el("td", "", q.label);
      add(name, el("div", "sub", q.kind + (q.feasible ? "" : " · infeasible: " + (q.violations || []).join(", "))));
      var box = el("div", "bandbox");
      var bar = el("div", "bandbar");
      bar.style.left = ((q.p10Bps - lo) / (hi - lo)) * 100 + "%";
      bar.style.width = Math.max(1, ((q.p90Bps - q.p10Bps) / (hi - lo)) * 100) + "%";
      var mark = el("div", "bandmark");
      mark.style.left = ((q.expectedBps - lo) / (hi - lo)) * 100 + "%";
      add(box, bar, mark);
      add(tr, name, el("td", "num", bp(q.expectedBps)), el("td", "num", bp(q.p10Bps) + " – " + bp(q.p90Bps)), el("td", "num", usd(q.expectedCostUsd)), add(el("td", "bandcell"), box));
      add(t, tr);
    });
    return t;
  }

  function checks(list) {
    var t = el("table");
    (list || []).forEach(function (c) {
      var tr = el("tr");
      var d = el("td", "", c.detail);
      if (c.fix) add(d, el("div", "fix", "Fix: " + c.fix));
      add(tr, el("td", c.status === "pass" ? "allow" : c.status === "hold" ? "hold" : "refuse", c.status.toUpperCase()), el("td", "", c.code), d);
      add(t, tr);
    });
    return t;
  }

  function renderPlan(d) {
    var s = d.strategy, i = d.intent || {};
    var v = String(d.verdict || "").toLowerCase();
    var size = i.notionalUsd !== undefined ? usd(i.notionalUsd) : qty(i.qty) + " sh";
    add(root,
      add(el("div", "row"), el("h1", "", (i.side || "") + " " + size + " " + (i.symbol || "")), el("span", "badge " + v, String(d.verdict || "").toUpperCase())),
      el("div", "sub", "Plan " + d.planId + " · signed Ed25519 · tickets valid until " + new Date(d.expiresAt).toISOString().replace(".000Z", "Z") + (i.deadlineNy ? " · deadline " + i.deadlineNy : "")));
    add(root, el("h2", "", "Venue options (cost band p10 – p90, bps of arrival mid)"));
    add(root, bandTable([s].concat(d.alternatives || []), s.id));
    add(root, el("h2", "", "Gate"), checks(d.checks));
    add(root, el("h2", "", "Slices (" + (d.slices || []).length + ")"));
    var t = el("table");
    add(t, add(el("tr"), el("th", "", "#"), el("th", "", "When"), el("th", "", "Venue"), el("th", "num", "Qty"), el("th", "", "Type"), el("th", "num", "Expected")));
    (d.slices || []).slice(0, 40).forEach(function (x) {
      add(t, add(el("tr"), el("td", "", x.index), el("td", "", x.ny), el("td", "", x.venue + (x.leg !== "entry" ? " · " + x.leg : "")), el("td", "num", qty(x.qty)), el("td", "", x.type + (x.conditional ? " (remainder)" : "")), el("td", "num", bp(x.expectedBps))));
    });
    add(root, t);
  }

  function renderTickets(d) {
    add(root, add(el("div", "row"), el("h1", "", "Tickets for plan " + d.planId), el("span", "badge " + (d.ok ? "allow" : "refuse"), d.ok ? "DRY RUN" : "REFUSED")));
    if (!d.ok) {
      add(root, el("p", "", d.reason));
      if (d.fixes && d.fixes.length) add(root, el("h2", "", "What to change"), checks(d.fixes));
      return;
    }
    add(root, el("div", "sub", "Built by Bitget's agent SDK in dry-run mode; nothing was sent."));
    var t = el("table");
    d.tickets.forEach(function (k) {
      var c = el("td");
      add(c, el("code", "", k.bgc));
      (k.notes || []).forEach(function (n) { add(c, el("div", "fix", n)); });
      add(t, add(el("tr"), el("td", "", "#" + k.index), el("td", "", k.kind), c));
    });
    add(root, t);
  }

  function renderOptions(d) {
    add(root, el("h1", "", "Options for " + (d.intent && d.intent.symbol)), el("div", "sub", "Gate preview: " + (d.gate ? d.gate.verdict.toUpperCase() : "n/a")));
    var rows = [];
    Object.keys(d.families || {}).forEach(function (k) { rows.push(d.families[k]); });
    if (d.baseline) rows.push(d.baseline);
    add(root, bandTable(rows, d.best && d.best.id));
  }

  function render(result) {
    var sc = result && (result.structuredContent || result);
    var d = sc && sc.data;
    while (root.firstChild) root.removeChild(root.firstChild);
    if (!d) { add(root, el("div", "empty", "No plan data in this result.")); return; }
    if (d.signedPlan) renderPlan(d);
    else if ("tickets" in d || ("ok" in d && "planId" in d)) renderTickets(d);
    else if ("families" in d) renderOptions(d);
    else add(root, el("div", "empty", "Unrecognised result."));
    reportSize();
  }

  var nextId = 1, pending = {};
  function post(msg) { if (window.parent && window.parent !== window) window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    var id = nextId++;
    post({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise(function (resolve) { pending[id] = resolve; });
  }
  function reportSize() {
    post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } });
  }
  window.addEventListener("message", function (ev) {
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method && pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; return; }
    if (m.method === "ui/notifications/tool-result") render(m.params);
    else if (m.method === "ui/resource-teardown" && m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, result: {} });
  });
  if (window.__SLIPWAY_RESULT__) render(window.__SLIPWAY_RESULT__);
  request("ui/initialize", { appInfo: { name: "slipway-plan-card", version: "0.1.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" })
    .then(function () { post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }); reportSize(); });
})();
</script>
</body>
</html>`;
