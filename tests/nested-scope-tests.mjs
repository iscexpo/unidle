#!/usr/bin/env node
// Acceptance tests for nested pipeline scopes (.unidle/a/b/, issue #8).
// Covers validation bounds, discovery ordering, checker/status/dependency
// flows across nesting levels, leases, wizard authoring, diff-merge output
// naming, dashboard routing, and flat-scope back-compat.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimLeases, listScopes, parseGates, readLeases, releaseLeases,
  statusLogPath, validateScopeId,
} from "../scripts/lib/gates.mjs";

const ROOT = "/workspaces/unidle";
const APPROVAL_DIR = mkdtempSync(join(tmpdir(), "unidle-test-nested-approvals-"));
process.env.UNIDLE_APPROVAL_DIR = APPROVAL_DIR;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log("ok   nested: " + name);
  } else {
    failures.push(name);
    console.log("FAIL nested: " + name + (detail ? "\n     " + String(detail).trim() : ""));
  }
}

const box = mkdtempSync(join(tmpdir(), "unidle-test-nested-root-"));
function writeLedger(scope, text, stem = "GATES") {
  const dir = join(box, ".unidle", ...scope.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, stem + ".md"), text);
}
function runnable(id, token) {
  return "- [ ] " + id + ": outcome " + id + "\n" +
    '  CHECK: node -e "console.log([\'' + token + '\'].join(\'\'))"\n' +
    "  EXPECT: " + token + "\n";
}
function metGate(id, token) {
  return "- [x] " + id + ": outcome " + id + "\n" +
    '  CHECK: node -e "console.log([\'' + token + '\'].join(\'\'))"\n' +
    "  EXPECT: " + token + "\n" +
    "  EVIDENCE: at=2026-08-24T00:00:00.000Z; exit=0; stdout: " + token + "\n";
}

writeLedger("web", metGate("w1", "flatok") + "\n");
mkdirSync(join(box, ".unidle", "web", "tmpdir"), { recursive: true });
writeLedger("web/dash", metGate("d1", "dashok") + "\n");
writeLedger("run/deep", runnable("deep1", "deepok"));
writeLedger("auth/web", "- [ ] g1: outcome g1\n");
writeLedger("app/api",
  "NEEDS-SCOPE: auth/web:GATES:g1\n\n" + runnable("r1", "apitok"));

// --- id validation bounds
check("validateScopeId accepts nested ids up to depth eight",
  validateScopeId("a/b") === null &&
  validateScopeId("a/b/c/d/e/f/g/h") === null);
check("validateScopeId rejects empty, doubled, and edge slashes",
  validateScopeId("") !== null && validateScopeId("a//b") !== null &&
  validateScopeId("/lead") !== null && validateScopeId("trail/") !== null);
check("validateScopeId rejects traversal in any segment",
  validateScopeId("..") !== null && validateScopeId("a/../b") !== null &&
  validateScopeId("a/b/../../c") !== null && validateScopeId(".") !== null);
check("validateScopeId rejects over-deep and hostile segments",
  validateScopeId("a/b/c/d/e/f/g/h/i") !== null &&
  validateScopeId("a\\b") !== null && validateScopeId("a b/c") !== null);

// --- discovery
check("listScopes discovers nested pipelines in sorted order and skips bare dirs",
  JSON.stringify(listScopes(box)) === JSON.stringify(["app/api", "auth/web", "run/deep", "web", "web/dash"]),
  JSON.stringify(listScopes(box)));

// --- parser accepts nested references
{
  const doc = parseGates(readFileSync(join(box, ".unidle/app/api/GATES.md"), "utf8"));
  check("parseGates keeps nested scope ids inside NEEDS-SCOPE references",
    doc.errors.length === 0 && doc.needsScope.length === 1 &&
    doc.needsScope[0].scope === "auth/web" && doc.needsScope[0].stem === "GATES");
}

function gateCheck(args) {
  return spawnSync(process.execPath,
    [join(ROOT, "scripts/gate-check.mjs"), "--root", box, ...args],
    { encoding: "utf8", env: process.env });
}

// --- status and dependency enforcement across nesting levels
{
  const result = gateCheck(["--status", "--scope", "web/dash"]);
  check("status verifies a nested pipeline green",
    result.status === 0 && result.stdout.includes("ALL MET") &&
    result.stdout.includes("[scope web/dash]"),
    result.stdout + result.stderr);
}
{
  const before = gateCheck(["--status", "--scope", "app/api"]);
  check("an unmet grandchild-level dependency blocks a deeply nested pipeline",
    before.status === 1 && before.stdout.includes("WAITING GATES.md") &&
    before.stdout.includes("BLOCKED BY auth/web:GATES:g1 (unmet)") &&
    before.stdout.includes("[scope app/api]"),
    before.stdout + before.stderr);
}
writeLedger("auth/web",
  "- [x] g1: outcome g1\n  EVIDENCE: reviewed by hand against the deployed config\n");
{
  const after = gateCheck(["--status", "--scope", "app/api"]);
  check("satisfying the nested dependency clears WAITING while own gates stay honest",
    after.status === 1 && !after.stdout.includes("BLOCKED BY") &&
    !after.stdout.includes("WAITING") && after.stdout.includes("UNMET GATES:r1"),
    after.stdout + after.stderr);
}

// --- execution inside nested scopes records evidence there
{
  const result = gateCheck(["--approve", "--scope", "run/deep"]);
  const ledger = readFileSync(join(box, ".unidle/run/deep/GATES.md"), "utf8");
  check("run mode executes and records evidence inside the nested scope dir",
    result.status === 0 && /- \[x\] deep1/.test(ledger) &&
    ledger.includes("EVIDENCE: at="),
    result.stdout + result.stderr + "\n     ledger: " + JSON.stringify(ledger));
}

// --- leases key on the full id
(async () => {
  {
    const claim = await claimLeases(box, { scope: "app/api", leaf: "l1", globs: ["src/api/**"] });
    const held = readLeases(box).find((lease) => lease.scope === "app/api");
    check("leases bind to nested scope ids",
      claim.ok === true && !!held && held.leaf === "l1");
    const clash = await claimLeases(box, { scope: "other", leaf: "x", globs: ["src/api/**"] });
    check("overlap detection still refuses conflicting claims across scopes",
      clash.ok === false && clash.conflicts.length === 1);
    await releaseLeases(box, { scope: "app/api" });
    check("release clears the nested-scope lease",
      !readLeases(box).some((lease) => lease.scope === "app/api"));
  }

  // --- wizard authors into a nested scope
  {
    const specPath = join(APPROVAL_DIR, "wiz-spec.json");
    writeFileSync(specPath, JSON.stringify({
      scope: "tools/gen",
      owns: ["tools/gen/**"],
      needsScope: [],
      gates: [{ id: "m1", title: "generated code reviewed" }],
    }));
    const result = spawnSync(process.execPath,
      [join(ROOT, "scripts/wizard.mjs"), "--from-json", specPath, "--root", box],
      { input: "", encoding: "utf8", env: process.env });
    check("wizard writes a lint-clean ledger into a nested scope",
      result.status === 0 && existsSync(join(box, ".unidle/tools/gen/GATES.md")),
      result.stdout + result.stderr);
  }

  // --- diff-merge tolerates flat ids while writing under nested targets
  {
    const result = spawnSync(process.execPath,
      [join(ROOT, "scripts/gates-diff.mjs"), "merge", "web", "web/integration", "--root", box],
      { encoding: "utf8", env: process.env });
    const outFile = join(box, ".unidle/web/integration/gates/node-from-web.md");
    const body = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
    const doc = body ? parseGates(body) : null;
    check("merge produces an integration ledger under the nested target scope",
      result.status === 0 && doc !== null && doc.errors.length === 0 &&
      body.includes("--reverify") && body.includes("EXPECT: ALL MET"),
      result.stdout + result.stderr);
    const tree = gateCheck(["--scope-tree"]);
    check("--scope-tree renders nested ids and cross-scope edges",
      tree.stdout.includes("scope web/dash") && tree.stdout.includes("scope app/api") &&
      tree.stdout.includes("-> auth/web:GATES:g1") && tree.stdout.includes("NO CYCLES"),
      tree.stdout);
  }

  // --- ambiguity still refused, listing full ids
  {
    const result = gateCheck(["--status"]);
    check("multi-pipeline roots refuse to guess, naming nested ids",
      result.status === 2 && result.stderr.includes("--scope") &&
      result.stderr.includes("web/dash"),
      result.stderr);
  }

  // --- dashboard routes multi-segment ids
  {
    gateCheck(["--log", "deep pipeline started", "--scope", "run/deep"]);
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath,
      [join(ROOT, "scripts/dashboard.mjs"), "--port", "0", "--root", box],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const base = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("dashboard late\n" + stdout)), 5000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) { clearTimeout(timer); resolvePromise("http://127.0.0.1:" + m[1]); }
      });
    });
    const get = (path) => new Promise((resolvePromise, rejectPromise) => {
      import("node:http").then(({ get: httpGet }) => {
        httpGet(base + path, (res) => {
          let body = ""; res.on("data", (c) => { body += c; });
          res.on("end", () => resolvePromise({ status: res.statusCode, body }));
        }).on("error", rejectPromise);
      });
    });
    try {
      const scoped = await get("/api/scope/web%2Fdash");
      check("dashboard serves nested ids through encoded routes",
        scoped.status === 200 && JSON.parse(scoped.body).name === "web/dash",
        scoped.body);
      const logged = await get("/api/log/run%2Fdeep");
      const logLines = logged.status === 200 ? JSON.parse(logged.body).lines : [];
      check("dashboard tails nested status timelines",
        logged.status === 200 && logLines.includes("deep pipeline started"),
        logged.body.slice(0, 200));
      const evil = await get("/api/scope/%2E%2E%2Fetc");
      check("traversal ids stay rejected through the joined route",
        evil.status === 404);
    } finally {
      child.kill();
    }
  }

  rmSync(box, { recursive: true, force: true });
  rmSync(APPROVAL_DIR, { recursive: true, force: true });

  console.log("\n" + passed + "/" + (passed + failures.length) + " passed" +
    (failures.length ? " (failures above)" : ""));
  process.exit(failures.length ? 1 : 0);
})();
