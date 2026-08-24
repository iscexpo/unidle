#!/usr/bin/env node
// report-tests.mjs : behavioural tests for gate-report.mjs.
// Zero dependencies, cross-platform (fixtures never run CHECK commands).
//
//   node tests/report-tests.mjs [filter]
//
// Prints "N/N passed" on success, matching the repo's other suites.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_REPORT = join(HERE, "..", "scripts", "gate-report.mjs");
const filter = process.argv[2] || "";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "unidle-test-report-"));
  return {
    path: dir,
    write(name, text) {
      const file = join(dir, name);
      writeFileSync(file, text);
      return file;
    },
  };
}

function run(args, env = {}, cwd) {
  return new Promise((done) => {
    execFile(process.execPath, [GATE_REPORT, ...args], {
      cwd: cwd || tmpdir(),
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      done({ code: error ? error.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const MET_GATE = (id) => "- [x] " + id + ": outcome for " + id + "\n" +
  '  CHECK: node -e "process.exit(0)"\n' +
  "  EXPECT: probe-" + id + "\n" +
  "  EVIDENCE: exit=0; shell=/bin/sh; output=probe-" + id + "\n";

const UNMET_GATE = (id, title) => "- [ ] " + id + ": " + title + "\n" +
  '  CHECK: node -e "process.exit(0)"\n' +
  "  EXPECT: probe-" + id + "\n" +
  "  EVIDENCE: pending\n";

function ledger(metIds, extras = "") {
  const body = metIds.map((id) => MET_GATE(id)).join("\n");
  return "# Leaf\n\n" + body + (extras ? "\n" + extras : "");
}

const ALL_MET = ledger(["g1", "g2", "g3", "g4", "g5"]);
const WITH_UNMET = ledger(["g1", "g2", "g3", "g4"], UNMET_GATE("g5", "fix the login flow"));
const WITH_ABANDONED = ledger(["g1", "g2", "g3", "g4"], UNMET_GATE("g5", "wire up the retry path") + "\nABANDON: g5: blocked upstream");

test("summary of a fully met ledger exits 0 and renders the table", async () => {
  const box = sandbox();
  const file = box.write("leaf-a.md", ALL_MET);
  const out = await run(["--summary", file]);
  if (out.code !== 0) throw new Error("exit " + out.code + ": " + out.stderr);
  for (const token of ["| Ledger | Gates | Met | Unmet | Abandoned | Result |",
    "| leaf-a | 5 | 5 | 0 | 0 | ✅ |", "**ALL MET (5 met)**"]) {
    if (!out.stdout.includes(token)) throw new Error("missing " + JSON.stringify(token));
  }
});

test("summary lists unmet gates with id, title, and exits 1", async () => {
  const box = sandbox();
  const file = box.write("leaf-b.md", WITH_UNMET);
  const out = await run(["--summary", file]);
  if (out.code !== 1) throw new Error("exit " + out.code);
  for (const token of ["### Unmet", "`leaf-b:g5` — fix the login flow", "| leaf-b | 5 | 4 | 1 | 0 | ❌ |",
    "**UNMET: 1 (met: 4)**"]) {
    if (!out.stdout.includes(token)) throw new Error("missing " + JSON.stringify(token));
  }
});

test("abandoned gates surface their reason without failing the report", async () => {
  const box = sandbox();
  const file = box.write("leaf-c.md", WITH_ABANDONED);
  const out = await run(["--summary", file]);
  if (out.code !== 0) throw new Error("exit " + out.code);
  for (const token of ["### Abandoned", "`leaf-c:g5` — blocked upstream", "**ALL MET (4 met, 1 abandoned)**"]) {
    if (!out.stdout.includes(token)) throw new Error("missing " + JSON.stringify(token));
  }
});

test("checked gates with pending evidence count as unmet", async () => {
  const box = sandbox();
  const checked = "- [x] g9: verify the deploy manifest\n" +
    '  CHECK: node -e "process.exit(0)"\n' +
    "  EXPECT: probe-g9\n" +
    "  EVIDENCE: pending\n";
  const file = box.write("leaf-d.md", ledger(["g1", "g2", "g3"], checked));
  const out = await run(["--summary", file]);
  if (out.code !== 1) throw new Error("exit " + out.code);
  if (!out.stdout.includes("`leaf-d:g9` — verify the deploy manifest (checked but EVIDENCE pending)")) {
    throw new Error("pending-evidence gate not reported as unmet");
  }
});

test("pr comment renders the report plus the status-only disclaimer", async () => {
  const box = sandbox();
  const file = box.write("leaf-e.md", WITH_UNMET);
  const out = await run(["--pr-comment", file]);
  if (out.code !== 1) throw new Error("exit " + out.code);
  for (const token of ["## 🧾 Unidle gates — standalone ledgers",
    "Status-only report from unidle gate-report.mjs: checks were never executed here"]) {
    if (!out.stdout.includes(token)) throw new Error("missing " + JSON.stringify(token));
  }
});

test("check-runs emits one API object per ledger with correct conclusions", async () => {
  const box = sandbox();
  const good = box.write("leaf-ok.md", ALL_MET);
  const bad = box.write("leaf-no.md", WITH_UNMET);
  const out = await run(["--check-runs", "--sha", "abc123", good, bad]);
  if (out.code !== 1) throw new Error("exit " + out.code);
  const payload = JSON.parse(out.stdout);
  if (!Array.isArray(payload) || payload.length !== 2) throw new Error("expected two check runs");
  const byName = Object.fromEntries(payload.map((entry) => [entry.name, entry]));
  const okRun = byName["unidle / leaf-ok"];
  const noRun = byName["unidle / leaf-no"];
  if (!okRun || !noRun) throw new Error("names missing: " + Object.keys(byName).join(", "));
  if (okRun.conclusion !== "success") throw new Error("ok conclusion " + okRun.conclusion);
  if (noRun.conclusion !== "failure") throw new Error("bad conclusion " + noRun.conclusion);
  for (const entry of payload) {
    if (entry.head_sha !== "abc123") throw new Error("head_sha not honored");
    if (entry.status !== "completed") throw new Error("status not completed");
    if (!entry.output || !entry.output.title || !entry.output.summary || !entry.output.text) throw new Error("output incomplete");
  }
  if (!noRun.output.title.startsWith("UNMET:")) throw new Error("failure title " + noRun.output.title);
  if (!noRun.output.text.includes("`leaf-no:g5`")) throw new Error("failing gate not in text");
});

test("check-runs falls back to GITHUB_SHA", async () => {
  const box = sandbox();
  const file = box.write("leaf-f.md", ALL_MET);
  const out = await run(["--check-runs", file], { GITHUB_SHA: "envsha42" });
  if (out.code !== 0) throw new Error("exit " + out.code);
  const payload = JSON.parse(out.stdout);
  if (payload[0].head_sha !== "envsha42") throw new Error("sha " + payload[0].head_sha);
});

test("check-runs without any sha exits 2", async () => {
  const box = sandbox();
  const file = box.write("leaf-g.md", ALL_MET);
  const out = await run(["--check-runs", file], { GITHUB_SHA: "" });
  if (out.code !== 2) throw new Error("exit " + out.code);
  if (!/needs --sha REF or GITHUB_SHA/.test(out.stderr)) throw new Error("unclear stderr: " + out.stderr);
});

test("--step-summary appends to GITHUB_STEP_SUMMARY instead of stdout", async () => {
  const box = sandbox();
  const file = box.write("leaf-h.md", ALL_MET);
  const summary = join(box.path, "summary.md");
  const out = await run(["--summary", "--step-summary", file], { GITHUB_STEP_SUMMARY: summary });
  if (out.code !== 0) throw new Error("exit " + out.code + ": " + out.stderr);
  if (out.stdout.trim()) throw new Error("stdout should be quiet in step-summary mode");
  if (!existsSync(summary)) throw new Error("summary not written");
  const text = readFileSync(summary, "utf8");
  if (!text.includes("**ALL MET (5 met)**")) throw new Error("summary content missing");
});

test("--step-summary without the environment variable exits 2", async () => {
  const box = sandbox();
  const file = box.write("leaf-i.md", ALL_MET);
  const out = await run(["--summary", "--step-summary", file], { GITHUB_STEP_SUMMARY: "" });
  if (out.code !== 2) throw new Error("exit " + out.code);
});

test("scope targeting resolves .unidle/<scope>/GATES.md and labels rows", async () => {
  const box = sandbox();
  mkdirSync(join(box.path, ".unidle", "api"), { recursive: true });
  writeFileSync(join(box.path, ".unidle", "api", "GATES.md"), ALL_MET);
  const out = await run(["--summary", "--root", box.path, "--scope", "api"], {}, box.path);
  if (out.code !== 0) throw new Error("exit " + out.code + ": " + out.stderr);
  if (!out.stdout.includes("| api/GATES | ")) throw new Error("row not scope-labeled");
  if (!out.stdout.includes("**ALL MET (5 met)** [scope api]")) throw new Error("footer not scoped");
});

test("multiple ledgers are all honored and grouped in one table", async () => {
  const box = sandbox();
  const a = box.write("one.md", ALL_MET);
  const b = box.write("two.md", WITH_UNMET);
  const out = await run(["--summary", a, b]);
  if (out.code !== 1) throw new Error("exit " + out.code);
  if (!out.stdout.includes("| one | 5 | 5 | 0 | 0 | ✅ |")) throw new Error("first row missing");
  if (!out.stdout.includes("| two | 5 | 4 | 1 | 0 | ❌ |")) throw new Error("second row missing");
  if ((out.stdout.match(/Unidle gates/g) || []).length !== 1) throw new Error("heading repeated");
});

test("a parse-error ledger exits 2, never 1", async () => {
  const box = sandbox();
  const file = box.write("broken.md", "# Ledger\n\n- [ ] broken-gate no colon title\n");
  const out = await run(["--summary", file]);
  if (out.code !== 2) throw new Error("exit " + out.code);
});

test("zero gate files found exits 2", async () => {
  const box = sandbox();
  const out = await run(["--summary", "--root", box.path]);
  if (out.code !== 2) throw new Error("exit " + out.code);
  if (!/no gate files found/.test(out.stderr)) throw new Error("stderr: " + out.stderr);
});

test("mode flags are mutually exclusive; unknown options exit 2", async () => {
  const box = sandbox();
  const file = box.write("leaf-j.md", ALL_MET);
  const both = await run(["--summary", "--check-runs", file]);
  if (both.code !== 2) throw new Error("exclusive modes exit " + both.code);
  const unknown = await run(["--wat", file]);
  if (unknown.code !== 2) throw new Error("unknown option exit " + unknown.code);
  const misfit = await run(["--check-runs", "--step-summary", file]);
  if (misfit.code !== 2) throw new Error("misplaced flag exit " + misfit.code);
});

let passed = 0;
for (const t of tests) {
  if (filter && !t.name.includes(filter)) continue;
  try {
    await t.fn();
    passed++;
    console.log("ok   report: " + t.name);
  } catch (error) {
    console.log("FAIL report: " + t.name + "\n     " + error.message);
  }
}
console.log("");
console.log(passed === tests.length
  ? passed + "/" + tests.length + " passed"
  : passed + "/" + tests.length + " passed (failures above)");
if (passed !== tests.length) process.exit(1);
