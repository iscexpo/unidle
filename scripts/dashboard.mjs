#!/usr/bin/env node
// Local, read-only dashboard over .unidle pipelines: live gate trees, evidence
// trails, status timeline, lease claims with conflict detection, and snapshot
// exports. Zero dependencies. Node 16+.
//
//   node scripts/dashboard.mjs [--port N] [--host ADDR] [--root DIR]
//
// Binds 127.0.0.1 unless --host says otherwise. GET only, fixed route table,
// no path-to-file mapping: nothing here executes a CHECK, records an
// approval, or writes anything.

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  UNIDLE_DIR, globsOverlap, gateState, listScopes, parseGates, readLeases,
  scopeFiles, statusLogPath, validateScopeId,
} from "./lib/gates.mjs";

const HELP = `usage: dashboard.mjs [--port N] [--host ADDR] [--root DIR]

Read-only local view of .unidle pipelines: live gate trees, evidence trails,
status timeline, lease claims with conflict detection, and snapshot exports
as JSON, markdown, or HTML.

defaults: port 4747, host 127.0.0.1, root = current directory`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

function optionValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value === "") {
    console.error("dashboard: " + name + " needs a value");
    process.exit(2);
  }
  return value;
}
function numberOption(name, fallback) {
  const raw = optionValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 65535) {
    console.error("dashboard: " + name + " needs an integer from 0 through 65535");
    process.exit(2);
  }
  return value;
}

const root = resolve(optionValue("--root") || process.cwd());
try {
  if (!statSync(root).isDirectory()) throw new Error("not a directory");
} catch (error) {
  console.error("dashboard: --root must be a directory (" + error.message + "): " + root);
  process.exit(2);
}
const port = numberOption("--port", 4747);
const host = optionValue("--host") || "127.0.0.1";

// ---------------------------------------------------------------- data

function readLedgerSnapshot(file) {
  const doc = parseGates(readFileSync(file, "utf8"));
  const gates = doc.gates.map((gate) => {
    const state = gateState(gate, doc.abandoned);
    return {
      id: gate.id,
      title: gate.title,
      state,
      checked: gate.checked,
      manual: !gate.check,
      evidence: gate.evidence || null,
      check: gate.check || null,
      expect: gate.expect || null,
      cwd: gate.cwd || null,
      abandonedReason: doc.abandoned.get(gate.id) ?? null,
    };
  });
  const counts = { met: 0, unmet: 0, abandoned: 0 };
  for (const gate of gates) {
    if (gate.state === "met") counts.met++;
    else if (gate.state === "abandoned") counts.abandoned++;
    else counts.unmet++;
  }
  return {
    file: relative(root, file).split(sep).join("/"),
    label: file.split(sep).pop().replace(/\.md$/i, ""),
    total: gates.length,
    met: counts.met,
    unmet: counts.unmet,
    abandoned: counts.abandoned,
    needsScope: doc.needsScope.map((ref) => ref.scope + ":" + ref.stem + ":" + ref.gate),
    errors: doc.errors.length ? doc.errors : null,
    gates,
  };
}

function scopeDetail(name) {
  return {
    name,
    ledgers: scopeFiles(root, name).map(readLedgerSnapshot),
  };
}

function logTail(name, max = 200) {
  const path = statusLogPath(root, name);
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-max);
  } catch {
    return [];
  }
}

function leaseConflicts(leases) {
  const conflicts = [];
  for (let i = 0; i < leases.length; i++) {
    for (let j = i + 1; j < leases.length; j++) {
      for (const glob of leases[i].globs) {
        const theirGlob = leases[j].globs.find((other) => globsOverlap(glob, other));
        if (theirGlob) {
          conflicts.push({
            a: leases[i].scope + "/" + leases[i].leaf,
            b: leases[j].scope + "/" + leases[j].leaf,
            glob, theirGlob,
          });
        }
      }
    }
  }
  return conflicts;
}

function collectState() {
  const scopes = listScopes(root).map(scopeDetail);
  const leases = readLeases(root).map(({ scope, leaf, globs, pid }) => ({ scope, leaf, globs, pid }));
  const logs = {};
  for (const scope of scopes) logs[scope.name] = logTail(scope.name);
  return {
    tool: "unidle dashboard",
    schema: 1,
    generatedAt: new Date().toISOString(),
    root,
    unidleDir: UNIDLE_DIR,
    scopes,
    leases,
    conflicts: leaseConflicts(leases),
    logs,
  };
}

// ------------------------------------------------------------- rendering

// Server-side escaping for every ledger-derived string that reaches HTML.
function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function cell(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}
const STATE_GLYPH = { met: "✔", unmet: "✖", "unmet-no-evidence": "⚠", abandoned: "🚫" };

function renderMarkdown(snapshot, name) {
  const out = ["# 🧾 Unidle pipeline — `" + name + "`", ""];
  for (const ledger of snapshot.scopes.find((s) => s.name === name)?.ledgers || []) {
    out.push("## " + cell(ledger.file) + "\n");
    out.push("| Gate | State | Title | Evidence |");
    out.push("| --- | --- | --- | --- |");
    for (const gate of ledger.gates) {
      out.push("| " + cell(gate.id) + " | " + (STATE_GLYPH[gate.state] || "?") + " " +
        cell(gate.state) + " | " + cell(gate.title) + " | " + cell(gate.evidence ?? "") + " |");
    }
    out.push("");
  }
  if (snapshot.conflicts.length) {
    out.push("## Lease conflicts\n");
    for (const conflict of snapshot.conflicts) {
      out.push("- " + cell(conflict.a) + " overlaps " + cell(conflict.b) +
        ": " + cell(conflict.glob) + " vs " + cell(conflict.theirGlob));
    }
    out.push("");
  }
  const logLines = snapshot.logs[name] || [];
  if (logLines.length) {
    out.push("## Status timeline\n");
    out.push("```text");
    out.push(...logLines.map(cell));
    out.push("```");
  }
  return out.join("\n") + "\n";
}

function renderHtmlSnapshot(snapshot, name) {
  const parts = [
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>unidle — ",
    esc(name),
    "</title><style>",
    SNIPPET_CSS,
    "</style></head><body><h1>🧾 unidle — ",
    esc(name),
    "</h1>",
  ];
  for (const ledger of snapshot.scopes.find((s) => s.name === name)?.ledgers || []) {
    parts.push("<section><h2>" + esc(ledger.file) + " (" + ledger.met + "/" + ledger.total + " met)</h2><table><tr><th>Gate</th><th>State</th><th>Title</th><th>Evidence</th></tr>");
    for (const gate of ledger.gates) {
      parts.push("<tr><td>" + esc(gate.id) + "</td><td>" + esc(STATE_GLYPH[gate.state] + " " + gate.state) +
        "</td><td>" + esc(gate.title) + "</td><td>" + esc(gate.evidence ?? "") + "</td></tr>");
    }
    parts.push("</table></section>");
  }
  parts.push("<p>Generated " + esc(snapshot.generatedAt) + " · read-only snapshot</p></body></html>");
  return parts.join("");
}

// The page shell embeds no ledger data; the client fetches JSON and renders
// through textContent, so ledger text can never become markup.
const SNIPPET_CSS = `body{background:#111;color:#ddd;font:14px/1.45 ui-monospace,Menlo,Consolas,monospace;margin:24px}
a{color:#7ab8ff}button{background:#222;color:#ddd;border:1px solid #444;border-radius:6px;padding:4px 10px;cursor:pointer}
button.on{border-color:#7ab8ff;color:#7ab8ff}h1{font-size:18px}h2{font-size:15px;margin:18px 0 6px}
table{border-collapse:collapse;margin:6px 0}td,th{border:1px solid #333;padding:3px 8px;text-align:left;font-size:13px}
.ok{color:#5dd97c}.bad{color:#ff6b6b}.warn{color:#ffd166}.gone{color:#777}
.cards{display:flex;gap:10px;margin:10px 0}.card{background:#191919;border:1px solid #333;border-radius:8px;padding:8px 14px}
.card b{display:block;font-size:20px}pre{background:#181818;border:1px solid #333;border-radius:8px;padding:10px;max-height:240px;overflow:auto}
.lease-conflict{color:#ff6b6b;font-weight:bold}details summary{cursor:pointer}.muted{color:#888}#conn{margin-left:8px}`;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>unidle dashboard</title>
<style>` + SNIPPET_CSS + `</style></head>
<body>
<h1>🧾 unidle <span id="conn" class="muted">connecting…</span></h1>
<div id="scopes"></div>
<div id="summary"></div>
<div id="content"></div>
<h2>Leases</h2><div id="leases" class="muted">none</div>
<h2>Status timeline</h2><pre id="log">(no entries)</pre>
<p class="muted">Read-only view. This page never executes checks or changes files.</p>
<script>
"use strict";
var STATE = null, CURRENT = null;
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function get(url, done) {
  var x = new XMLHttpRequest();
  x.open("GET", url);
  x.onload = function () { done(x.status >= 200 && x.status < 300 ? x.responseText : null); };
  x.onerror = function () { done(null); };
  x.send();
}
function pick() {
  if (!STATE || !STATE.scopes.length) return null;
  if (!CURRENT || !STATE.scopes.some(function (s) { return s.name === CURRENT; })) return STATE.scopes[0].name;
  return CURRENT;
}
function gateLine(gate) {
  var row = el("li");
  var glyph = { "met": "ok", "unmet-no-evidence": "warn", "abandoned": "gone", "unmet": "bad" }[gate.state] || "muted";
  row.appendChild(el("span", glyph, "[" + gate.state + "] "));
  row.appendChild(el("strong", null, gate.id + ": "));
  row.appendChild(el("span", null, gate.title));
  if (gate.manual) row.appendChild(el("span", "muted", " (manual)"));
  if (gate.abandonedReason) row.appendChild(el("span", "gone", " — " + gate.abandonedReason));
  if (gate.evidence) {
    var details = el("details");
    details.appendChild(el("summary", "muted", "evidence"));
    details.appendChild(el("code", null, gate.evidence));
    row.appendChild(details);
  }
  if (gate.check) {
    var cmd = el("details");
    cmd.appendChild(el("summary", "muted", "oracle"));
    cmd.appendChild(el("code", null, (gate.check || "") + "  ⇒  EXPECT " + (gate.expect || "") + (gate.cwd ? "  @ " + gate.cwd : "")));
    row.appendChild(cmd);
  }
  return row;
}
function render() {
  var conn = document.getElementById("conn");
  conn.textContent = "live · " + STATE.generatedAt + " · polling 2s";
  conn.className = "ok";
  var tabs = document.getElementById("scopes");
  tabs.textContent = "";
  STATE.scopes.forEach(function (scope) {
    var b = el("button", scope.name === CURRENT ? "on" : null, scope.name + " (" + scope.ledgers.reduce(function (n, l) { return n + l.unmet; }, 0) + " open)");
    b.onclick = function () { CURRENT = scope.name; render(); };
    tabs.appendChild(b);
    tabs.appendChild(document.createTextNode(" "));
  });
  var content = document.getElementById("content");
  content.textContent = "";
  var summary = document.getElementById("summary");
  summary.textContent = "";
  var scope = STATE.scopes.find(function (s) { return s.name === CURRENT; });
  if (!scope) { content.appendChild(el("p", "muted", "(no pipelines under .unidle/)")); }
  else {
    var totals = scope.ledgers.reduce(function (acc, l) {
      acc.met += l.met; acc.unmet += l.unmet; acc.abandoned += l.abandoned; return acc;
    }, { met: 0, unmet: 0, abandoned: 0 });
    [["met ✔", totals.met, "ok"], ["open ✖", totals.unmet, "bad"], ["abandoned 🚫", totals.abandoned, "gone"]].forEach(function (pair) {
      var c = el("div", "card");
      c.appendChild(el("b", pair[2], String(pair[1])));
      c.appendChild(el("span", null, pair[0]));
      summary.appendChild(c);
    });
    scope.ledgers.forEach(function (ledger) {
      var sec = el("section");
      sec.appendChild(el("h2", null, ledger.file + " (" + ledger.met + "/" + ledger.total + " met)"));
      if (ledger.needsScope.length) sec.appendChild(el("p", "warn", "WAITING on " + ledger.needsScope.join(", ")));
      var list = el("ul");
      ledger.gates.forEach(function (gate) { list.appendChild(gateLine(gate)); });
      sec.appendChild(list);
      content.appendChild(sec);
    });
    var exports = el("p", null, "export: ");
    [["json", "&format=json"], ["markdown", "&format=md"], ["html", "&format=html"]].forEach(function (pair) {
      var a = el("a", null, pair[0]);
      a.href = "/api/export/" + encodeURIComponent(CURRENT) + "?attachment=1" + pair[1];
      exports.appendChild(a);
      exports.appendChild(document.createTextNode(" · "));
    });
    content.appendChild(exports);
  }
  var leaseBox = document.getElementById("leases");
  leaseBox.textContent = "";
  if (!STATE.leases.length) leaseBox.appendChild(el("span", "muted", "none held"));
  STATE.leases.forEach(function (lease) {
    var conflicted = STATE.conflicts.some(function (c) {
      return c.a === lease.scope + "/" + lease.leaf || c.b === lease.scope + "/" + lease.leaf;
    });
    var row = el("div");
    row.appendChild(el("span", conflicted ? "lease-conflict" : null,
      lease.scope + "/" + lease.leaf + (conflicted ? " ⚠ CONFLICT" : "")));
    row.appendChild(el("span", "muted", "  owns: " + lease.globs.join(", ") + "  pid " + lease.pid));
    leaseBox.appendChild(row);
  });
  var pre = document.getElementById("log");
  var lines = (STATE.logs || {})[CURRENT] || [];
  pre.textContent = lines.length ? lines.join("\\n") : "(no entries)";
}
function tick() {
  get("/api/state", function (text) {
    if (!text) { document.getElementById("conn").textContent = "offline"; return; }
    try { STATE = JSON.parse(text); } catch { return; }
    CURRENT = pick();
    render();
  });
}
tick();
setInterval(tick, 2000);
</script></body></html>`;

// ---------------------------------------------------------------- serving

function send(response, code, body, type, extra) {
  response.writeHead(code, Object.assign({
    "Content-Type": type + "; charset=utf-8",
    "Cache-Control": "no-store",
  }, extra || {}));
  response.end(body);
}
function sendJson(response, code, value, extra) {
  send(response, code, JSON.stringify(value, null, 2), "application/json", extra);
}
function notFound(response, message) {
  sendJson(response, 404, { error: message || "not found" });
}

const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "method not allowed; this dashboard is read-only" });
    return;
  }
  let pathname = "";
  try { pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname); }
  catch { notFound(response, "bad path"); return; }
  const query = new URL(request.url, "http://localhost").searchParams;
  const segments = pathname.split("/").filter(Boolean);

  try {
    if (pathname === "/" || pathname === "/index.html") {
      send(response, 200, PAGE, "text/html");
      return;
    }
    if (segments[0] !== "api") { notFound(response); return; }

    if (segments[1] === "state") { sendJson(response, 200, collectState()); return; }

    if (segments[1] === "scopes" && segments.length === 2) {
      sendJson(response, 200, { root, scopes: listScopes(root) });
      return;
    }

    if ((segments[1] === "scope" || segments[1] === "log" || segments[1] === "export") && segments.length === 3) {
      const name = segments[2];
      const invalid = validateScopeId(name);
      if (invalid || !listScopes(root).includes(name)) { notFound(response, "no such pipeline"); return; }

      if (segments[1] === "scope") { sendJson(response, 200, scopeDetail(name)); return; }

      if (segments[1] === "log") {
        sendJson(response, 200, { scope: name, lines: logTail(name) });
        return;
      }

      const format = (query.get("format") || "json").toLowerCase();
      const attachment = query.get("attachment") === "1";
      if (format === "json") {
        const snapshot = collectState();
        const scoped = { ...snapshot, scopes: [snapshot.scopes.find((s) => s.name === name)].filter(Boolean) };
        sendJson(response, 200, scoped, attachment
          ? { "Content-Disposition": "attachment; filename=\"unidle-" + name + "-snapshot.json\"" }
          : undefined);
        return;
      }
      if (format === "md" || format === "html") {
        const snapshot = collectState();
        const body = format === "md" ? renderMarkdown(snapshot, name) : renderHtmlSnapshot(snapshot, name);
        const type = format === "md" ? "text/markdown" : "text/html";
        send(response, 200, body, type, attachment
          ? { "Content-Disposition": "attachment; filename=\"unidle-" + name + "." + format + "\"" }
          : undefined);
        return;
      }
      notFound(response, "unknown export format; use json, md, or html");
      return;
    }

    if (segments[1] === "leases" && segments.length === 2) {
      const leases = readLeases(root).map(({ scope, leaf, globs, pid }) => ({ scope, leaf, globs, pid }));
      sendJson(response, 200, { leases, conflicts: leaseConflicts(leases) });
      return;
    }

    notFound(response);
  } catch (error) {
    sendJson(response, 500, { error: "dashboard failed to serve this route: " + error.message });
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  console.log("unidle dashboard → http://" + host + ":" + actual + " (root: " + root + ")");
});
