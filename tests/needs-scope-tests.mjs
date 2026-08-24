#!/usr/bin/env node
// needs-scope-tests.mjs : cross-scope NEEDS-SCOPE dependencies, --scope-tree,
// and multi-scope verification. Zero dependencies, cross-platform.
//
//   node tests/needs-scope-tests.mjs [filter]
//
// Prints "N/N passed" on success, matching the repo's other suites.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_CHECK = join(HERE, "..", "scripts", "gate-check.mjs");
const filter = process.argv[2] || "";
const APPROVAL_ROOT = mkdtempSync(join(tmpdir(), "unidle-test-needs-approvals-"));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "unidle-test-needs-"));
  return {
    path: dir,
    write(name, text) {
      const file = join(dir, name);
      writeFileSync(file, text);
      return file;
    },
    read: (name) => readFileSync(join(dir, name), "utf8"),
    scope(name) {
      return (file, text) => {
        mkdirSync(dirname(join(dir, ".unidle", name, file)), { recursive: true });
        const target = join(dir, ".unidle", name, file);
        writeFileSync(target, text);
        return target;
      };
    },
  };
}

const PROBE = 'CHECK: node -e "console.log(\'probe\'); process.exit(0)"';
const RUNNABLE = (id) => "- [ ] " + id + ": outcome " + id + "\n  " + PROBE + "\n  EXPECT: probe\n";
const MET_RUNNABLE = (id) => "- [x] " + id + ": outcome " + id + "\n  " + PROBE +
  "\n  EXPECT: probe\n  EVIDENCE: at=2026-01-01T00:00:00.000Z; exit=0; shell=/bin/sh; cwd=.; path=x/1 entries; output=probe\n";
const MANUAL_GATE = (id) => "- [ ] " + id + ": judged by hand";

function run(args, cwd) {
  return new Promise((done) => {
    execFile(process.execPath, [GATE_CHECK, ...args], {
      cwd: cwd || tmpdir(),
      env: { ...process.env, UNIDLE_APPROVAL_DIR: APPROVAL_ROOT },
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      done({ code: error ? error.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function makeBox() {
  const box = sandbox();
  box.writeIn = (scopeName, file, text) => box.scope(scopeName)(file, text);
  return box;
}

test("a met dependency leaves the ledger green", async () => {
  const box = makeBox();
  box.writeIn("dep", "GATES.md", MET_RUNNABLE("g1"));
  box.writeIn("main", "GATES.md",
    "NEEDS-SCOPE: dep:GATES:g1\n\n" + MET_RUNNABLE("m1") + "\n");
  const out = await run(["--status", "--root", box.path, "--scope", "main"], box.path);
  if (out.code !== 0) throw new Error("exit " + out.code + ": " + out.stdout + out.stderr);
});

test("an unmet dependency blocks status with WAITING and exits 1", async () => {
  const box = makeBox();
  box.writeIn("dep", "GATES.md", RUNNABLE("g1"));
  box.writeIn("main", "GATES.md",
    "NEEDS-SCOPE: dep:GATES:g1\n\n" + MANUAL_GATE("m1") + "\n");
  const out = await run(["--status", "--root", box.path, "--scope", "main"], box.path);
  if (out.code !== 1) throw new Error("exit " + out.code + ": " + out.stdout);
  if (!out.stdout.includes("WAITING GATES.md")) throw new Error(out.stdout);
  if (!out.stdout.includes("BLOCKED BY dep:GATES:g1 (unmet)")) throw new Error(out.stdout);
});

test("run mode executes nothing while dependencies are unmet", async () => {
  const box = makeBox();
  box.writeIn("dep", "GATES.md", RUNNABLE("g1"));
  box.writeIn("main", "GATES.md",
    "NEEDS-SCOPE: dep:GATES:g1\n\n" + RUNNABLE("own") + "\n");
  const out = await run(["--approve", "--root", box.path, "--scope", "main"], box.path);
  if (out.code !== 1) throw new Error("exit " + out.code + ": " + out.stdout);
  if (/APPROVAL REQUIRED|^\s+RUN /.test(out.stdout)) throw new Error("executed despite being WAITING:\n" + out.stdout);
  if (!out.stdout.includes("DEPENDENCIES UNMET: nothing executed")) throw new Error(out.stdout);
});

test("missing foreign ledger fails usage instead of guessing", async () => {
  const box = makeBox();
  box.writeIn("main", "GATES.md",
    "NEEDS-SCOPE: ghost:GATES:g1\n\n" + MANUAL_GATE("m1") + "\n");
  const out = await run(["--status", "--root", box.path, "--scope", "main"], box.path);
  if (out.code !== 2) throw new Error("exit " + out.code + ": " + out.stdout);
  if (!/dependency ledger not found.*ghost:GATES:g1/s.test(out.stderr)) throw new Error(out.stderr);
});

test("malformed references are parse errors", async () => {
  const box = makeBox();
  box.writeIn("main", "GATES.md",
    "NEEDS-SCOPE: dep:g1\n\n" + MANUAL_GATE("m1") + "\n");
  const out = await run(["--status", "--root", box.path, "--scope", "main"], box.path);
  if (out.code !== 2) throw new Error("exit " + out.code);
  if (!/malformed NEEDS-SCOPE reference/.test(out.stderr)) throw new Error(out.stderr);

  const late = makeBox();
  late.writeIn("dep", "GATES.md", MET_RUNNABLE("g1"));
  late.writeIn("main", "GATES.md",
    MANUAL_GATE("m1") + "\nNEEDS-SCOPE: dep:GATES:g1\n");
  const outLate = await run(["--status", "--root", late.path, "--scope", "main"], late.path);
  if (outLate.code !== 2) throw new Error("late directive exit " + outLate.code);
  if (!/NEEDS-SCOPE must appear before the first gate/.test(outLate.stderr)) throw new Error(outLate.stderr);
});

test("invalid scope ids in references fail closed", async () => {
  const box = makeBox();
  box.writeIn("main", "GATES.md",
    "NEEDS-SCOPE: ../evil:GATES:g1\n\n" + MANUAL_GATE("m1") + "\n");
  const out = await run(["--status", "--root", box.path, "--scope", "main"], box.path);
  if (out.code !== 2) throw new Error("exit " + out.code);
  if (!/NEEDS-SCOPE scope must match/.test(out.stderr)) throw new Error(out.stderr);
});

test("an abandoned dependency blocks; satisfying the dependency flips the report green", async () => {
  const box = makeBox();
  box.writeIn("dep", "GATES.md",
    RUNNABLE("g1") + "\nABANDON: g1: handed off elsewhere\n");
  box.writeIn("main", "GATES.md",
    "NEEDS-SCOPE: dep:GATES:g1\n\n" + MET_RUNNABLE("m1") + "\n");
  const before = await run(["--status", "--root", box.path, "--scope", "main"], box.path);
  if (before.code !== 1 || !before.stdout.includes("(abandoned)")) throw new Error(before.stdout);

  box.writeIn("dep", "GATES.md", MET_RUNNABLE("g1"));
  const after = await run(["--status", "--root", box.path, "--scope", "main"], box.path);
  if (after.code !== 0) throw new Error("exit " + after.code + ": " + after.stdout);
});

test("same-scope references resolve against gates/<stem>.md", async () => {
  const box = makeBox();
  box.writeIn("api", "gates/leaf-1.1.md", MET_RUNNABLE("l1"));
  box.writeIn("api", "GATES.md",
    "NEEDS-SCOPE: api:leaf-1.1:l1\n\n" + MET_RUNNABLE("m1") + "\n");
  const out = await run(["--status", "--root", box.path, "--scope", "api"], box.path);
  if (out.code !== 0) throw new Error("exit " + out.code + ": " + out.stdout + out.stderr);
});

test("--scope-tree lists pipelines, gates, and edges", async () => {
  const box = makeBox();
  box.writeIn("auth", "GATES.md", MET_RUNNABLE("g1"));
  box.writeIn("api", "GATES.md",
    "NEEDS-SCOPE: auth:GATES:g1\n\n" + MANUAL_GATE("m1") + "\n");
  const out = await run(["--scope-tree", "--root", box.path], box.path);
  if (out.code !== 0) throw new Error("exit " + out.code + ": " + out.stderr);
  for (const token of ["scope api", "scope auth", "-> auth:GATES:g1", "NO CYCLES"]) {
    if (!out.stdout.includes(token)) throw new Error("missing " + JSON.stringify(token) + ":\n" + out.stdout);
  }
});

test("--scope-tree detects dependency cycles", async () => {
  const box = makeBox();
  box.writeIn("a", "GATES.md", "NEEDS-SCOPE: b:GATES:g9\n\n" + MANUAL_GATE("m1") + "\n");
  box.writeIn("b", "GATES.md", "NEEDS-SCOPE: a:GATES:g9\n\n" + MANUAL_GATE("m1") + "\n");
  const out = await run(["--scope-tree", "--root", box.path], box.path);
  if (out.code !== 0) throw new Error("exit " + out.code);
  if (!/CYCLE: (a -> b -> a|b -> a -> b)/.test(out.stdout)) throw new Error(out.stdout);
});

test("comma-separated --scope verifies several pipelines in one invocation", async () => {
  const box = makeBox();
  box.writeIn("alpha", "GATES.md", RUNNABLE("a1"));
  box.writeIn("beta", "GATES.md", RUNNABLE("b1"));
  const out = await run(["--approve", "--reverify", "--root", box.path, "--scope", "alpha,beta"], box.path);
  if (out.code !== 0) throw new Error("exit " + out.code + ": " + out.stdout + out.stderr);
  if (!out.stdout.includes("ALL MET") || !out.stdout.includes("[scope alpha,beta]")) throw new Error(out.stdout);
  if (!box.read(".unidle/alpha/GATES.md").includes("- [x] a1")) throw new Error("alpha not executed");
  if (!box.read(".unidle/beta/GATES.md").includes("- [x] b1")) throw new Error("beta not executed");

  const withAction = await run(["--claim", "--root", box.path, "--scope", "alpha,beta"], box.path);
  if (withAction.code !== 2) throw new Error("actions must reject multi-scope, got " + withAction.code);
  const missing = await run(["--status", "--root", box.path, "--scope", "alpha,gamma"], box.path);
  if (missing.code !== 2 || !/no such scope/.test(missing.stderr)) throw new Error(missing.stderr);
});

let passed = 0;
for (const t of tests) {
  if (filter && !t.name.includes(filter)) continue;
  try {
    await t.fn();
    passed++;
    console.log("ok   needs-scope: " + t.name);
  } catch (error) {
    console.log("FAIL needs-scope: " + t.name + "\n     " + error.message);
  }
}
console.log("");
console.log(passed === tests.length
  ? passed + "/" + tests.length + " passed"
  : passed + "/" + tests.length + " passed (failures above)");
if (passed !== tests.length) process.exit(1);
