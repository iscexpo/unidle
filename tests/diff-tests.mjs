#!/usr/bin/env node
// diff-tests.mjs : behavioural tests for gates-diff.mjs.
// Zero dependencies, cross-platform (no CHECK is ever executed here).
//
//   node tests/diff-tests.mjs [filter]
//
// Prints "N/N passed" on success, matching the repo's other suites.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATES_DIFF = join(HERE, "..", "scripts", "gates-diff.mjs");
const GATE_LINT = join(HERE, "..", "scripts", "gate-lint.mjs");
const filter = process.argv[2] || "";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "unidle-test-diff-"));
  return {
    path: dir,
    write(name, text) {
      const file = join(dir, name);
      writeFileSync(file, text);
      return file;
    },
    read: (name) => readFileSync(join(dir, name), "utf8"),
  };
}

function run(args, cwd) {
  return new Promise((done) => {
    execFile(process.execPath, [GATES_DIFF, ...args], {
      cwd: cwd || tmpdir(),
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      done({ code: error ? error.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function gate(id, title, body) {
  const checked = body.startsWith("MANUAL") ? "[ ]" : "[x]";
  const lines = ["- " + checked + " " + id + ": " + title];
  if (!body.startsWith("MANUAL")) lines.push(...body.split("\n").map((line) => "  " + line));
  return lines.join("\n");
}

const MET = (id, check, expect, cwd) =>
  gate(id, "outcome " + id, "CHECK: " + check + "\nEXPECT: " + expect +
    (cwd ? "\nCWD: " + cwd : "") + "\nEVIDENCE: exit=0; output=probe");

const BASE_LEDGER = [
  "# Base",
  "",
  MET("g1", "node a.mjs", "A"),
  MET("g2", "node b.mjs", "B", "sub"),
  gate("g3", "manual outcome", "MANUAL"),
].join("\n\n");

test("diff of identical ledgers exits 0 with no relevant differences", async () => {
  const box = sandbox();
  const a = box.write("a.md", BASE_LEDGER);
  const b = box.write("b.md", BASE_LEDGER);
  const out = await run(["diff", a, b]);
  if (out.code !== 0) throw new Error("exit " + out.code);
  if (!out.stdout.includes("NO OUTCOME-RELEVANT DIFFERENCES")) throw new Error(out.stdout);
});

test("added and removed gates are outcome-relevant (tamper detection)", async () => {
  const box = sandbox();
  const a = box.write("a.md", BASE_LEDGER);
  const fewer = box.write("fewer.md", MET("g1", "node a.mjs", "A"));
  const more = box.write("more.md", BASE_LEDGER + "\n\n" + MET("g9", "node i.mjs", "I"));
  const removed = await run(["diff", a, fewer]);
  if (removed.code !== 1 || !removed.stdout.includes("REMOVED g2")) throw new Error(removed.stdout);
  const added = await run(["diff", a, more]);
  if (added.code !== 1 || !added.stdout.includes("ADDED g9")) throw new Error(added.stdout);
});

test("check, expect, and cwd changes are each oracle-changed", async () => {
  const box = sandbox();
  const a = box.write("a.md", BASE_LEDGER);
  for (const [label, replacement] of [
    ["check", MET("g2", "node b2.mjs", "B", "sub")],
    ["expect", MET("g2", "node b.mjs", "B2", "sub")],
    ["cwd", MET("g2", "node b.mjs", "B", "elsewhere")],
  ]) {
    const text = BASE_LEDGER.replace(MET("g2", "node b.mjs", "B", "sub"), replacement);
    const b = box.write(label + ".md", text);
    const out = await run(["diff", a, b]);
    if (out.code !== 1 || !out.stdout.includes("ORACLE-CHANGED g2: " + label)) {
      throw new Error(label + ": " + out.stdout);
    }
  }
});

test("new ABANDON lines weaken proof obligations and exit 1; evidence-only drift does not", async () => {
  const box = sandbox();
  const a = box.write("a.md", BASE_LEDGER);
  const abandoned = box.write("ab.md", BASE_LEDGER + "\nABANDON: g1: skipped now");
  const outAbandon = await run(["diff", a, abandoned]);
  if (outAbandon.code !== 1 || !outAbandon.stdout.includes("ABANDONED g1")) throw new Error(outAbandon.stdout);

  const evidenceDrift = box.write("ev.md", BASE_LEDGER.replace(
    "EVIDENCE: exit=0; output=probe", "EVIDENCE: at=2026-01-01T00:00:00.000Z; exit=0; output=new"));
  const outEvidence = await run(["diff", a, evidenceDrift]);
  if (outEvidence.code !== 0 || !outEvidence.stdout.includes("EVIDENCE-ONLY g1")) throw new Error(outEvidence.stdout);
});

test("invalidate demotes oracle-changed gates in place and records why", async () => {
  const box = sandbox();
  const a = box.write("old.md", BASE_LEDGER);
  const changed = BASE_LEDGER.replace(MET("g1", "node a.mjs", "A"), MET("g1", "node z.mjs", "A"));
  const n = box.write("new.md", changed);
  const out = await run(["invalidate", a, n]);
  if (out.code !== 0 || !out.stdout.includes("INVALIDATED g1: check")) throw new Error(out.stdout + out.stderr);
  const after = box.read("new.md");
  if (!after.includes("- [ ] g1: outcome g1")) throw new Error(after);
  if (!after.includes("EVIDENCE: pending")) throw new Error(after);
  if (!after.includes("<!-- unidle: oracle changed (check); prior evidence invalidated -->")) throw new Error(after);
  if (!after.includes("- [x] g2: outcome g2")) throw new Error("untouched gate was modified:\n" + after);
});

test("invalidate carries evidence only across allowlisted field changes", async () => {
  const box = sandbox();
  const a = box.write("old.md", BASE_LEDGER);
  const moved = BASE_LEDGER.replace("CWD: sub", "CWD: other");
  const n = box.write("moved.md", moved);

  const strict = await run(["invalidate", a, n]);
  if (strict.code !== 0 || !strict.stdout.includes("INVALIDATED g2: cwd")) throw new Error(strict.stdout);

  writeFileSync(n, moved);
  const migrated = await run(["invalidate", "--migrate-ignore", "cwd", a, n]);
  if (migrated.code !== 0 || !migrated.stdout.includes("MIGRATED g2: cwd")) throw new Error(migrated.stdout);
  const after = box.read("moved.md");
  if (!after.includes("[migrated after cwd change]")) throw new Error(after);
  if (!after.includes("- [x] g2: outcome g2")) throw new Error("migrated gate lost its checkbox");

  const refused = await run(["invalidate", "--migrate-ignore", "check", a, box.write("x.md", moved)]);
  if (refused.code !== 2) throw new Error("check must never be migratable, exit " + refused.code);
  const unknownField = await run(["invalidate", "--migrate-ignore", "vibes", a, box.write("y.md", moved)]);
  if (unknownField.code !== 2) throw new Error("unknown allowlist field accepted");
});

test("invalidate on an unchanged ledger is a no-op that writes nothing", async () => {
  const box = sandbox();
  const a = box.write("same.md", BASE_LEDGER);
  const before = box.read("same.md");
  const out = await run(["invalidate", a, a]);
  if (out.code !== 0 || !out.stdout.includes("NO ORACLE CHANGES")) throw new Error(out.stdout);
  if (box.read("same.md") !== before) throw new Error("ledger was rewritten");
});

test("export writes meta plus one line per gate with signature and approval key", async () => {
  const box = sandbox();
  const ledger = box.write("leaf.md", BASE_LEDGER);
  const auditDir = join(box.path, "audit");
  const out = await run(["export", auditDir, ledger]);
  if (out.code !== 0) throw new Error(out.stderr);
  const file = join(auditDir, "unidle-evidence.jsonl");
  if (!existsSync(file)) throw new Error("audit log missing");
  const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  if (lines[0].type !== "meta" || typeof lines[0].generatedAt !== "string") throw new Error("meta line bad");
  const gates = lines.filter((line) => line.type === "gate");
  if (gates.length !== 3) throw new Error("expected 3 gate lines, got " + gates.length);
  for (const entry of gates) {
    if (!/^[0-9a-f]{64}$/.test(entry.signature)) throw new Error("signature not sha256 hex");
    if (!/^[0-9a-f]{64}$/.test(entry.approvalKey)) throw new Error("approvalKey not sha256 hex");
    if (!entry.oracle || typeof entry.oracle.cwd !== "string") throw new Error("oracle missing");
    if (!["met", "unmet"].includes(entry.state)) throw new Error("state " + entry.state);
  }
  void ledger;
});

test("export refuses to overwrite without --force", async () => {
  const box = sandbox();
  const ledger = box.write("leaf.md", BASE_LEDGER);
  const auditDir = join(box.path, "audit");
  const first = await run(["export", auditDir, ledger]);
  if (first.code !== 0) throw new Error(first.stderr);
  const second = await run(["export", auditDir, ledger]);
  if (second.code !== 2) throw new Error("overwrite allowed, exit " + second.code);
  const forced = await run(["export", "--force", auditDir, ledger]);
  if (forced.code !== 0) throw new Error(forced.stderr);
});

test("merge generates an unchecked node ledger whose checks reverify children", async () => {
  const box = sandbox();
  mkdirScope(box, "v1", { "GATES.md": BASE_LEDGER, "gates/leaf-1.1.md": MET("l1", "node x.mjs", "X") });
  const out = await run(["merge", "v1", "v2", "--root", box.path]);
  if (out.code !== 0 || !out.stdout.includes("MERGED 2 child ledger(s)")) throw new Error(out.stdout + out.stderr);
  const merged = box.read(".unidle/v2/gates/node-from-v1.md");
  if (!merged.includes("- [ ] leaf-1.1: v1/leaf-1.1 holds (1 runnable gates)")) throw new Error(merged);
  if (!merged.includes('CHECK: node "') || !merged.includes('--reverify ".unidle/v1/gates/leaf-1.1.md"')) {
    throw new Error(merged);
  }
  if (!merged.includes("EXPECT: ALL MET")) throw new Error(merged);
  if (/^- \[x\]/m.test(merged)) throw new Error("consolidated proof must start unchecked");

  const lint = await new Promise((done) => {
    execFile(process.execPath, [GATE_LINT, join(box.path, ".unidle", "v2", "gates", "node-from-v1.md")],
      (error, stdout, stderr) => done({ code: error ? error.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
  if (lint.code === 2) throw new Error("generated ledger fails to parse: " + lint.stderr);

  const again = await run(["merge", "v1", "v2", "--root", box.path]);
  if (again.code !== 2) throw new Error("silent overwrite allowed");
  const forced = await run(["merge", "v1", "v2", "--root", box.path, "--force"]);
  if (forced.code !== 0) throw new Error(forced.stderr);
});

test("merge skips ledgers without runnable gates and rejects unknown scopes", async () => {
  const box = sandbox();
  mkdirScope(box, "solo", {});
  const manualOnly = [
    "# Manual",
    "",
    gate("m1", "judged by hand", "MANUAL"),
  ].join("\n");
  writeFileSync(join(box.path, ".unidle", "solo", "GATES.md"), manualOnly);
  const skipped = await run(["merge", "solo", "next", "--root", box.path]);
  if (skipped.code !== 2 || !/lacks runnable gates/.test(skipped.stderr)) throw new Error(skipped.stderr);

  const missing = await run(["merge", "ghost", "next", "--root", box.path]);
  if (missing.code !== 2) throw new Error("unknown scope accepted");
  const same = await run(["merge", "solo", "solo", "--root", box.path]);
  if (same.code !== 2) throw new Error("identical scopes accepted");
  const evil = await run(["merge", "../evil", "next", "--root", box.path]);
  if (evil.code !== 2) throw new Error("traversal scope accepted");
});

test("parse errors and malformed invocations exit 2", async () => {
  const box = sandbox();
  const broken = box.write("broken.md", "# L\n\n- [ ] nogate no colon\n");
  const good = box.write("good.md", BASE_LEDGER);
  const parse = await run(["diff", good, broken]);
  if (parse.code !== 2) throw new Error("parse error exit " + parse.code);
  const arity = await run(["diff", good]);
  if (arity.code !== 2) throw new Error("arity exit " + arity.code);
  const unknown = await run(["frobnicate", good, good]);
  if (unknown.code !== 2) throw new Error("command exit " + unknown.code);
  const flag = await run(["diff", "--wat", good, good]);
  if (flag.code !== 2) throw new Error("option exit " + flag.code);
});

function mkdirScope(box, scope, files) {
  mkdirSync(join(box.path, ".unidle", scope, "gates"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(box.path, ".unidle", scope, name), text);
  }
}

let passed = 0;
for (const t of tests) {
  if (filter && !t.name.includes(filter)) continue;
  try {
    await t.fn();
    passed++;
    console.log("ok   diff: " + t.name);
  } catch (error) {
    console.log("FAIL diff: " + t.name + "\n     " + error.message);
  }
}
console.log("");
console.log(passed === tests.length
  ? passed + "/" + tests.length + " passed"
  : passed + "/" + tests.length + " passed (failures above)");
if (passed !== tests.length) process.exit(1);
