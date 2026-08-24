#!/usr/bin/env node
// Acceptance tests for scripts/dashboard.mjs (issue #6).
// Boots the real server on port 0 against a fixture .unidle tree and checks
// the JSON API shapes, export formats, XSS inertness, and read-only posture.

import { spawn } from "node:child_process";
import * as node_http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/dashboard.mjs", import.meta.url).pathname;
const APPROVAL_ROOT = mkdtempSync(join(tmpdir(), "unidle-test-dashboard-"));
process.env.UNIDLE_APPROVAL_DIR = APPROVAL_ROOT;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log("ok   dashboard: " + name);
  } else {
    failures.push(name);
    console.log("FAIL dashboard: " + name + (detail ? "\n     " + String(detail).trim() : ""));
  }
}

// ------------------------------------------------------------------ fixture

function runnable(id) {
  return "- [ ] " + id + ": outcome " + id + "\n" +
    '  CHECK: node -e "console.log(\'probe\'); process.exit(0)"\n' +
    "  EXPECT: probe\n";
}
function metGate(id) {
  return "- [x] " + id + ": outcome " + id + "\n" +
    '  CHECK: node -e "console.log(\'probe\'); process.exit(0)"\n' +
    "  EXPECT: probe\n" +
    "  EVIDENCE: at=2026-08-24T00:00:00.000Z; exit=0; stdout: probe\n";
}
function manualGate(id, title) {
  return "- [ ] " + id + ": " + title + "\n";
}

const box = {
  path: mkdtempSync(join(tmpdir(), "unidle-test-dash-fixture-")),
};
function writeIn(scope, file, text) {
  const dir = file === "GATES.md"
    ? join(box.path, ".unidle", scope)
    : join(box.path, ".unidle", scope, "gates");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
}

// scope "web": one met gate, one unmet runnable, one manual gate with an XSS
// payload as its title.
writeIn("web", "GATES.md",
  metGate("m1") + "\n" + runnable("r1") + "\n" +
  manualGate("x1", "<script>alert('pwn')</script> & \"quotes\"") + "\n");
// scope "api": all green.
writeIn("api", "GATES.md",
  metGate("a1") + "\n" + metGate("a2") + "\n");
// status timeline for web.
mkdirSync(join(box.path, ".unidle", "web"), { recursive: true });
writeFileSync(join(box.path, ".unidle", "web", "status.log"),
  "2026-08-24T00:00:00.000Z [web] STARTED\n" +
  "2026-08-24T00:01:00.000Z [web] MET GATES:m1\n");

// Two leases that overlap -> dashboard must surface the conflict pair.
function lease(scope, leaf, globs, pid) {
  return { scope, leaf, globs, pid };
}
mkdirSync(join(box.path, ".unidle", "locks"), { recursive: true });
writeFileSync(join(box.path, ".unidle", "locks", "lease-web-leaf-1.lease"),
  JSON.stringify(lease("web", "leaf-1", ["src/shared/**"], 111)) + "\n");
writeFileSync(join(box.path, ".unidle", "locks", "lease-api-leaf-9.lease"),
  JSON.stringify(lease("api", "leaf-9", ["src/shared/util.mjs"], 222)) + "\n");

// ------------------------------------------------------------------- server

let child = null;
let base = null;

function startServer() {
  return new Promise((resolvePromise, rejectPromise) => {
    child = spawn(process.execPath, [SCRIPT, "--port", "0", "--root", box.path], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => rejectPromise(new Error("server did not report a URL in time\n" + stdout + stderr)), 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && !base) {
        base = "http://127.0.0.1:" + match[1];
        clearTimeout(timer);
        resolvePromise(base);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => {
      if (!base) {
        clearTimeout(timer);
        rejectPromise(new Error("server exited early code=" + code + "\n" + stdout + stderr));
      }
    });
  });
}

function request(pathname, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = node_http.get(base + pathname, options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolvePromise({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", rejectPromise);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function untilReady() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await request("/api/scopes");
      if (res.status === 200) return;
    } catch { /* not listening yet */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("dashboard never became ready");
}

try {
  await startServer();
  await untilReady();

  // --- basics
  const scopesRes = await request("/api/scopes");
  check("GET /api/scopes answers 200 json",
    scopesRes.status === 200 &&
    /application\/json/.test(scopesRes.headers["content-type"] || ""));
  const scopesBody = JSON.parse(scopesRes.body);
  check("/api/scopes lists fixture pipelines sorted",
    Array.isArray(scopesBody.scopes) &&
    scopesBody.scopes.join(",") === "api,web" &&
    typeof scopesBody.root === "string");

  // --- scope detail shape
  const webRes = await request("/api/scope/web");
  const web = JSON.parse(webRes.body);
  const ledger = (web.ledgers || []).find((l) => l.file === ".unidle/web/GATES.md");
  const byId = Object.fromEntries((ledger?.gates || []).map((g) => [g.id, g]));
  check("/api/scope/:id exposes per-gate state, evidence, and oracle fields",
    !!ledger && byId.m1.state === "met" && !!byId.m1.evidence &&
    byId.r1.state === "unmet" && byId.x1.manual === true &&
    byId.m1.check.includes("console.log") && byId.m1.expect === "probe");
  check("/api/scope/:id totals count met/unmet/abandoned",
    ledger.met === 1 && ledger.unmet === 2 && ledger.abandoned === 0 && ledger.total === 3);

  const apiScope = JSON.parse((await request("/api/scope/api")).body);
  const apiLedger = apiScope.ledgers[0];
  check("all-met pipeline reports met total",
    apiLedger.met === 2 && apiLedger.unmet === 0);

  // --- XSS inertness
  check("json api keeps payload but declares application/json (browsers never execute)",
    (await request("/api/scope/web")).body.includes("<script>alert('pwn')</script>") &&
    /application\/json/.test((await request("/api/scope/web")).headers["content-type"]));
  const htmlExport = await request("/api/export/web?format=html");
  check("html export escapes every ledger string server-side",
    htmlExport.status === 200 &&
    htmlExport.body.includes("&lt;script&gt;alert(&#39;pwn&#39;)&lt;/script&gt;") &&
    !htmlExport.body.includes("<script"));
  const mdExport = await request("/api/export/web?format=md");
  check("markdown export renders table rows with states",
    mdExport.status === 200 &&
    mdExport.body.includes("| m1 | ✔ met |") &&
    mdExport.body.includes("| x1 | ✖ unmet |"));

  // --- aggregated state endpoint used by the page shell
  const state = JSON.parse((await request("/api/state")).body);
  const conflictPair = [state.conflicts[0]?.a, state.conflicts[0]?.b].sort().join("|");
  check("/api/state aggregates scopes, leases, conflicts, logs",
    state.scopes.length === 2 &&
    state.leases.length === 2 &&
    state.conflicts.length === 1 &&
    conflictPair === "api/leaf-9|web/leaf-1" &&
    (state.logs.web || []).some((line) => line.includes("MET GATES:m1")));

  // --- leases endpoint
  const leases = JSON.parse((await request("/api/leases")).body);
  const leaseGlobs = leases.conflicts[0]
    ? [leases.conflicts[0].glob, leases.conflicts[0].theirGlob].sort()
    : [];
  check("/api/leases returns held leases plus overlap conflicts",
    leases.leases.length === 2 &&
    leases.conflicts.length === 1 &&
    leaseGlobs.join("|") === "src/shared/**|src/shared/util.mjs");

  // --- log tail endpoint
  const logRes = JSON.parse((await request("/api/log/web")).body);
  check("/api/log/:scope tails the status timeline",
    logRes.lines.length === 2 && logRes.lines[1].includes("[web] MET"));

  // --- page shell
  const page = await request("/");
  check("/ serves the app shell without embedding any ledger data",
    page.status === 200 && /text\/html/.test(page.headers["content-type"]) &&
    page.body.includes("setInterval(tick, 2000)") &&
    !page.body.includes("probe") && !page.body.includes("<script>alert"));

  // --- snapshot export as attachment
  const attachment = await request("/api/export/api?format=json&attachment=1");
  const parsedAttachment = JSON.parse(attachment.body);
  check("export json honors format+attachment and snapshots one scope",
    /attachment/.test(attachment.headers["content-disposition"] || "") &&
    parsedAttachment.scopes.length === 1 && parsedAttachment.scopes[0].name === "api");

  // --- failure modes
  check("unknown route 404s", (await request("/api/nope")).status === 404);
  check("unknown pipeline 404s", (await request("/api/scope/ghost")).status === 404);
  check("traversal-shaped pipeline id 404s", (await request("/api/scope/..%2F..%2Fetc")).status === 404);
  check("invalid scope id 404s instead of touching fs",
    (await request("/api/scope/" + encodeURIComponent("bad/id"))).status === 404);
  check("unknown export format is rejected",
    (await request("/api/export/web?format=exe")).status === 404);

  const post = await new Promise((resolvePromise) => {
    const req = node_http.request(base + "/api/state", { method: "POST" }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolvePromise({ status: res.statusCode, body }));
    });
    req.end("{}");
  });
  check("non-GET methods are refused 405 (read-only forever)",
    post.status === 405 && post.body.includes("read-only"));

  // --- empty repo still works
  const emptyDir = mkdtempSync(join(tmpdir(), "unidle-test-dash-empty-"));
  const emptyChild = spawn(process.execPath, [SCRIPT, "--port", "0", "--root", emptyDir],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let emptyStdout = "";
  const emptyBase = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("empty server late\n" + emptyStdout)), 5000);
    emptyChild.stdout.on("data", (chunk) => {
      emptyStdout += chunk;
      const m = emptyStdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolvePromise("http://127.0.0.1:" + m[1]); }
    });
  });
  const emptyScopes = JSON.parse((await new Promise((resolvePromise, rejectPromise) => {
    node_http.get(emptyBase + "/api/scopes", (res) => {
      let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolvePromise({ status: res.statusCode, body: b }));
    }).on("error", rejectPromise);
  })).body);
  check("root without pipelines serves an empty state gracefully",
    emptyScopes.scopes.length === 0);
  emptyChild.kill();
  rmSync(emptyDir, { recursive: true, force: true });

  // --- binds loopback only by default
  check("default bind is 127.0.0.1", base.startsWith("http://127.0.0.1:"));
} catch (error) {
  failures.push("(harness) " + error.message);
  console.log("FAIL dashboard: harness error\n     " + error.stack);
} finally {
  if (child) child.kill();
}

rmSync(box.path, { recursive: true, force: true });
rmSync(APPROVAL_ROOT, { recursive: true, force: true });

console.log("\n" + passed + "/" + (passed + failures.length) + " passed" +
  (failures.length ? " (failures above)" : ""));
process.exit(failures.length ? 1 : 0);
