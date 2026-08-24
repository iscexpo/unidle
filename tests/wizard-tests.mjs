#!/usr/bin/env node
// Acceptance tests for scripts/wizard.mjs (issue #7).
// Batch mode drives the full validate -> lint-guard -> preview pipeline
// non-interactively; a piped-stdin session proves the interview path.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGates } from "../scripts/lib/gates.mjs";
import { lintDocument } from "../scripts/lib/lint-rules.mjs";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/wizard.mjs", import.meta.url));

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log("ok   wizard: " + name);
  } else {
    failures.push(name);
    console.log("FAIL wizard: " + name + (detail ? "\n     " + String(detail).trim() : ""));
  }
}

const box = mkdtempSync(join(tmpdir(), "unidle-test-wizard-root-"));
const inbox = mkdtempSync(join(tmpdir(), "unidle-test-wizard-json-"));

function metGate(id) {
  return "- [x] " + id + ": outcome " + id + "\n" +
    '  CHECK: node -e "console.log(\'probe\'); process.exit(0)"\n' +
    "  EXPECT: probe\n" +
    "  EVIDENCE: at=2026-08-24T00:00:00.000Z; exit=0; stdout: probe\n";
}
mkdirSync(join(box, ".unidle", "auth"), { recursive: true });
writeFileSync(join(box, ".unidle", "auth", "GATES.md"), metGate("g1") + "\n");
mkdirSync(join(box, ".unidle", "other"), { recursive: true });
writeFileSync(join(box, ".unidle", "other", "GATES.md"), "OWNS: src/shared/**\n\n- [ ] o1: outcome o1\n");

let jsonSeq = 0;
function runWizard(spec, options = {}) {
  const file = join(inbox, "spec-" + (++jsonSeq) + ".json");
  writeFileSync(file, JSON.stringify(spec));
  return spawnSync(process.execPath,
    [SCRIPT, "--from-json", file, "--root", box, ...(options.flags || [])],
    { input: options.input || "", encoding: "utf8", env: process.env });
}

const ledgerFor = (scope) => join(box, ".unidle", scope, "GATES.md");
const notWritten = (scope) => !existsSync(ledgerFor(scope));

// --- happy path: runnable + manual gate, owns, verified dependency
{
  const result = runWizard({
    scope: "api",
    owns: ["src/api/**"],
    needsScope: ["auth:GATES:g1"],
    gates: [
      { id: "g1", title: "probe outcome holds", check: "node -e \"console.log(['pro','be'].join(''))\"", expect: "probe" },
      { id: "m1", title: "human sign-off recorded" },
    ],
  });
  const text = existsSync(ledgerFor("api")) ? readFileSync(ledgerFor("api"), "utf8") : "";
  const doc = text ? parseGates(text) : null;
  check("happy path writes the ledger and exits zero",
    result.status === 0 && !!text && result.stdout.includes("WROTE "),
    result.stderr || "status=" + result.status + " error=" + result.error +
    " stdout=" + JSON.stringify(result.stdout.slice(-200)));
  check("generated layout puts OWNS and NEEDS-SCOPE before the first gate",
    text.indexOf("OWNS: src/api/**") < text.indexOf("NEEDS-SCOPE: auth:GATES:g1") &&
    text.indexOf("NEEDS-SCOPE: auth:GATES:g1") < text.indexOf("- [ ] g1:"));
  check("gates are written unchecked with canonical attributes",
    doc && doc.gates.length === 2 && doc.gates.every((gate) => !gate.checked) &&
    doc.gates[0].check.includes("console.log") && doc.owns.join(",") === "src/api/**" &&
    doc.needsScope.length === 1);
  const lint = doc ? lintDocument(doc) : [];
  check("generated ledger is lint-clean of errors",
    !!doc && doc.errors.length === 0 && !lint.some((finding) => finding.level === "error"));
  check("preview sampled the real oracle and reported MET",
    /PREVIEW g1: exit=0; EXPECT=matched/.test(result.stdout) &&
    result.stdout.includes("sample verdict: MET") &&
    result.stdout.includes("probe"));
}

// --- preview can be disabled
{
  const result = runWizard({
    scope: "noprev",
    owns: [],
    needsScope: [],
    gates: [{ id: "r1", title: "never runs", check: "node -e \"process.exit(7)\"", expect: "nope" }],
  }, { flags: ["--no-preview"] });
  check("--no-preview skips oracle execution entirely",
    result.status === 0 && !result.stdout.includes("PREVIEW"),
    result.stdout + result.stderr);
}

// --- duplicate gate ids are rejected before anything is written
{
  const result = runWizard({
    scope: "dup",
    owns: [], needsScope: [],
    gates: [
      { id: "g1", title: "first", check: "node -e \"console.log('a')\"", expect: "a" },
      { id: "g1", title: "second", check: "node -e \"console.log('b')\"", expect: "b" },
    ],
  });
  check("duplicate gate ids reject with nothing written",
    result.status === 1 && result.stderr.includes("duplicate gate id g1") && notWritten("dup"),
    result.stderr);
}

// --- ownership conflicts against existing pipelines
{
  const result = runWizard({
    scope: "clash",
    owns: ["src/shared/util.mjs"], needsScope: [], gates: [{ id: "m1", title: "manual" }],
  });
  check("OWNS overlap with another pipeline is rejected fail-closed",
    result.status === 1 && result.stderr.includes("overlaps") && notWritten("clash"),
    result.stderr);
}
{
  const result = runWizard({
    scope: "selfclash",
    owns: ["src/a/**", "src/a/b/**"], needsScope: [], gates: [{ id: "m1", title: "manual" }],
  });
  check("intra-spec OWNS overlaps are rejected",
    result.status === 1 && result.stderr.includes("overlap") && notWritten("selfclash"),
    result.stderr);
}

// --- dependency references must exist on disk
{
  const result = runWizard({
    scope: "ghostdep",
    owns: [], needsScope: ["ghost:GATES:g1"], gates: [{ id: "m1", title: "manual" }],
  });
  check("missing dependency ledger is rejected",
    result.status === 1 && result.stderr.includes("missing ledger") && notWritten("ghostdep"),
    result.stderr);
}
{
  const result = runWizard({
    scope: "ghostgate",
    owns: [], needsScope: ["auth:GATES:nope"], gates: [{ id: "m1", title: "manual" }],
  });
  check("dependency pointing at an unknown gate is rejected",
    result.status === 1 && result.stderr.includes("unknown gate") && notWritten("ghostgate"),
    result.stderr);
}
{
  const result = runWizard({
    scope: "malformedref",
    owns: [], needsScope: ["only-two-parts"], gates: [{ id: "m1", title: "manual" }],
  });
  check("malformed reference syntax is rejected",
    result.status === 1 && result.stderr.includes("malformed NEEDS-SCOPE") && notWritten("malformedref"),
    result.stderr);
}

// --- linter guard blocks tautological oracles
{
  const result = runWizard({
    scope: "tautology",
    owns: [], needsScope: [],
    gates: [{ id: "g1", title: "cannot fail", check: "echo done", expect: "done" }],
  });
  check("linter guard rejects CHECKs that cannot fail",
    result.status === 1 && /tautological-check|cannot fail/i.test(result.stderr) && notWritten("tautology"),
    result.stderr);
}

// --- runnable gates need both halves
{
  const result = runWizard({
    scope: "halforacle",
    owns: [], needsScope: [],
    gates: [{ id: "g1", title: "one half", check: "node -e \"console.log('x')\"" }],
  });
  check("CHECK without EXPECT is rejected",
    result.status === 1 && result.stderr.includes("both CHECK and EXPECT") && notWritten("halforacle"),
    result.stderr);
}

// --- usage failures exit 2 without touching disk
check("invalid scope id exits 2",
  runWizard({ scope: "bad//id", owns: [], needsScope: [], gates: [{ id: "m1", title: "t" }] }).status === 2);
check("an existing pipeline is refused instead of recreated",
  (() => {
    const result = runWizard({ scope: "auth", owns: [], needsScope: [], gates: [{ id: "m1", title: "t" }] });
    return result.status === 2 && result.stderr.includes("already has a ledger");
  })());
check("zero gates is rejected",
  runWizard({ scope: "empty", owns: [], needsScope: [], gates: [] }).status === 1);

// --- interactive interview via piped stdin
{
  const answers = [
    "ia",              // scope
    "src/ia/**",       // owns path
    "",                // finish owns
    "",                // skip NEEDS-SCOPE
    "m1",              // gate id
    "sign-off recorded", // title
    "",                // no CHECK -> manual
    "y",               // add this gate
    "",                // finish gates
  ].join("\n") + "\ny\n"; // final write confirm
  const result = spawnSync(process.execPath, [SCRIPT, "--root", box],
    { input: answers, encoding: "utf8", env: process.env });
  const text = existsSync(ledgerFor("ia")) ? readFileSync(ledgerFor("ia"), "utf8") : "";
  check("interactive session writes the interviewed ledger",
    result.status === 0 && text.includes("- [ ] m1: sign-off recorded") &&
    text.includes("OWNS: src/ia/**"),
    result.stdout + result.stderr);
}
{
  const answers = [
    "declined", "", "",
    "m1", "title", "", "y", "",
  ].join("\n") + "\nn\n"; // decline the final write
  const result = spawnSync(process.execPath, [SCRIPT, "--root", box],
    { input: answers, encoding: "utf8", env: process.env });
  check("declining the final write leaves disk untouched",
    result.status === 0 && result.stdout.includes("Aborted; nothing was written.") &&
    !existsSync(ledgerFor("declined")),
    result.stdout + result.stderr);
}

rmSync(box, { recursive: true, force: true });
rmSync(inbox, { recursive: true, force: true });

console.log("\n" + passed + "/" + (passed + failures.length) + " passed" +
  (failures.length ? " (failures above)" : ""));
process.exit(failures.length ? 1 : 0);
