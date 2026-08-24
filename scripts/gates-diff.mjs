#!/usr/bin/env node
// Track ledger changes and manage oracle invalidation over time.
// Zero runtime dependencies. Requires Node.js 16+.
//
//   gates-diff.mjs diff OLD NEW
//       Report added, removed, oracle-changed, abandonment-changed, and
//       cosmetic differences by gate id. Exit 1 when anything weakens or
//       moves the proof obligations (including gate removal and new
//       ABANDON lines); exit 0 for cosmetic or evidence-only drift.
//
//   gates-diff.mjs invalidate OLD NEW [--migrate-ignore FIELD,FIELD]
//       Rewrite NEW in place. Gates whose CHECK, EXPECT, or CWD changed are
//       demoted: unchecked, EVIDENCE reset to pending, with an in-ledger
//       comment recording what happened. With --migrate-ignore, a change
//       covered entirely by the allowlist carries its evidence forward with
//       an appended marker instead. CHECK and EXPECT are never migratable.
//
//   gates-diff.mjs export DIR [--scope ID | --root DIR | file ...]
//       Write one JSONL audit line per gate (plus a meta header) capturing
//       state, evidence, oracle identity, and the exact approval key the
//       checker would derive. Refuses to overwrite unless --force.
//
//   gates-diff.mjs merge OLD_SCOPE NEW_SCOPE [--force]
//       Generate .unidle/NEW_SCOPE/gates/node-from-OLD_SCOPE.md with one
//       unchecked runnable gate per OLD_SCOPE child; each CHECK re-verifies
//       that child through gate-check --reverify, so consolidated proof is
//       re-run, not inherited. Inspect, approve, then run like any oracle.
//
// exit codes: 0 clean/action succeeded; 1 outcome-relevant differences;
//             2 usage/parse/infrastructure.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatDocument, gateState, listScopes, parseGates, resolveTarget,
  sha256, scopeFiles, validateScopeId, withFileLock, writeAtomic,
} from "./lib/gates.mjs";
import { createOracle, DEFAULT_TIMEOUT_SECONDS, resolveShellOrThrow } from "./lib/runner.mjs";

const HELP = `usage: gates-diff.mjs <command> [args]

commands:
  diff OLD NEW                                  compare two ledgers
  invalidate OLD NEW [--migrate-ignore FIELDS]  demote changed oracles in NEW
  export DIR [--scope ID | --root DIR | files]  JSONL evidence audit log
  merge OLD_SCOPE NEW_SCOPE [--force]           consolidate child verification

common options:
  --root DIR     repository/pipeline root (default current directory)
  --force        overwrite existing outputs (invalidate/export/merge)

--migrate-ignore accepts comma-separated oracle field names (cwd, timeoutMs,
shell, path, maxOutputBytes, regexTimeoutMs, platform). CHECK and EXPECT can
never be ignored: their change is an outcome change by definition.

exit codes: 0 clean/succeeded; 1 outcome-relevant differences; 2 error.`;

const KNOWN_ORACLE_FIELDS = new Set([
  "check", "expect", "cwd", "shell", "timeoutMs",
  "maxOutputBytes", "regexTimeoutMs", "platform", "path",
]);
const OUTCOME_FIELDS = ["check", "expect", "cwd"];
const AUTHORED_FIELDS = ["check", "expect", "cwd"];

function fail(message) {
  console.error("gates-diff: " + message);
  console.error("run gates-diff.mjs --help for usage");
  process.exit(2);
}

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  const knownFlags = new Set(["--force", "--migrate-ignore", "--scope", "--root"]);
  let onlyPositional = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!onlyPositional && arg === "--") { onlyPositional = true; continue; }
    if (!onlyPositional && arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (!knownFlags.has(name)) fail("unknown option " + name);
      if (flags.has(name)) fail("duplicate option " + name);
      if (name === "--force") { flags.set(name, true); continue; }
      const value = equals === -1 ? argv[++index] : arg.slice(equals + 1);
      if (value === undefined || value === "") fail(name + " needs a value");
      flags.set(name, value);
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function loadDoc(file, label) {
  let text;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { fail("cannot read " + label + " " + file + ": " + error.message); }
  const doc = parseGates(text);
  if (doc.errors.length) {
    for (const error of doc.errors) console.error("gates-diff: " + label + ": " + error);
    process.exit(2);
  }
  return doc;
}

function authored(gate) {
  return { check: gate.check, expect: gate.expect, cwd: gate.cwd };
}

function differingFields(left, right, fields) {
  return fields.filter((field) => (left[field] ?? null) !== (right[field] ?? null));
}

// ---------------------------------------------------------------- diff

function commandDiff(oldFile, newFile) {
  const oldDoc = loadDoc(oldFile, "OLD");
  const newDoc = loadDoc(newFile, "NEW");
  const oldById = new Map(oldDoc.gates.map((gate) => [gate.id, gate]));
  const newById = new Map(newDoc.gates.map((gate) => [gate.id, gate]));

  let relevant = 0;
  const counts = { added: 0, removed: 0, changed: 0, abandon: 0, retitled: 0, stateOnly: 0 };
  const unchangedIds = [];

  for (const [id, gate] of newById) {
    if (!oldById.has(id)) {
      counts.added++;
      relevant++;
      console.log("ADDED " + id + ": " + gate.title);
      continue;
    }
    const before = oldById.get(id);
    const fields = differingFields(authored(before), authored(gate), AUTHORED_FIELDS);
    if (fields.length) {
      counts.changed++;
      relevant++;
      console.log("ORACLE-CHANGED " + id + ": " + fields.join(", "));
      continue;
    }
    const wasAbandoned = oldDoc.abandoned.has(id);
    const isAbandoned = newDoc.abandoned.has(id);
    if (wasAbandoned !== isAbandoned) {
      counts.abandon++;
      relevant++;
      console.log(isAbandoned ? "ABANDONED " + id : "UN-ABANDONED " + id);
      continue;
    }
    if (before.title !== gate.title) {
      counts.retitled++;
      console.log("RETITLED " + id + ": " + JSON.stringify(before.title) + " -> " + JSON.stringify(gate.title));
    }
    const beforeState = gateState(before, oldDoc.abandoned);
    const afterState = gateState(gate, newDoc.abandoned);
    if (beforeState !== afterState || (before.evidence ?? "") !== (gate.evidence ?? "")) {
      counts.stateOnly++;
      console.log("EVIDENCE-ONLY " + id + ": " + beforeState + " -> " + afterState);
    } else if (before.title === gate.title) unchangedIds.push(id);
  }

  for (const [id, gate] of oldById) {
    if (!newById.has(id)) {
      counts.removed++;
      relevant++;
      console.log("REMOVED " + id + ": " + gate.title);
    }
  }

  counts.unchanged = unchangedIds.length;
  console.log("DIFF SUMMARY: added=" + counts.added + " removed=" + counts.removed +
    " oracle-changed=" + counts.changed + " abandon-changed=" + counts.abandon +
    " retitled=" + counts.retitled + " evidence-only=" + counts.stateOnly +
    " unchanged=" + counts.unchanged);
  console.log(relevant ? "OUTCOME-RELEVANT DIFFERENCES: " + relevant : "NO OUTCOME-RELEVANT DIFFERENCES");
  process.exit(relevant ? 1 : 0);
}

// ------------------------------------------------------------ invalidate

function parseAllowlist(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  const requested = String(raw).split(",").map((item) => item.trim()).filter(Boolean);
  const allowed = [];
  for (const field of requested) {
    if (field === "check" || field === "expect") {
      fail("--migrate-ignore cannot include " + field + ": its change is an outcome change");
    }
    if (!KNOWN_ORACLE_FIELDS.has(field)) {
      fail("unknown --migrate-ignore field " + JSON.stringify(field) +
        " (known: " + [...KNOWN_ORACLE_FIELDS].filter((f) => f !== "check" && f !== "expect").join(", ") + ")");
    }
    allowed.push(field);
  }
  return allowed;
}

function lastAttrLineAfter(doc, gate) {
  let line = gate.line + 1;
  while (line < doc.lines.length && /^\s+(CHECK|EXPECT|EVIDENCE|CWD):/.test(doc.lines[line])) line++;
  return line;
}

function setEvidence(doc, gate, value) {
  if (gate.evidenceLine !== -1) {
    const indent = (doc.lines[gate.evidenceLine].match(/^\s*/) || ["  "])[0];
    doc.lines[gate.evidenceLine] = indent + "EVIDENCE: " + value;
    return;
  }
  doc.lines.splice(lastAttrLineAfter(doc, gate), 0, "  EVIDENCE: " + value);
}

async function commandInvalidate(oldFile, newFile, allowlist) {
  const oldDoc = loadDoc(oldFile, "OLD");
  const summary = await withFileLock(dirname(resolve(newFile)), resolve(newFile), () => {
    const invalidated = [];
    const migrated = [];
    const noEffect = [];
    const doc = parseGates(readFileSync(newFile, "utf8"));
    if (doc.errors.length) {
      for (const error of doc.errors) console.error("gates-diff: NEW: " + error);
      process.exit(2);
    }
    for (const gate of doc.gates) {
      const before = oldDoc.gates.find((candidate) => candidate.id === gate.id);
      if (!before) continue;
      const fields = differingFields(authored(before), authored(gate), AUTHORED_FIELDS);
      if (!fields.length) continue;

      const hasCarryableEvidence = gate.checked &&
        gate.evidence !== null && gate.evidence !== "" && !/^pending$/i.test(gate.evidence.trim());
      const migratable = allowlist.length > 0 && fields.every((field) => allowlist.includes(field));

      if (migratable && hasCarryableEvidence) {
        setEvidence(doc, gate, gate.evidence + " [migrated after " + fields.join("/") + " change]");
        migrated.push(gate.id + ": " + fields.join("/"));
      } else if (!hasCarryableEvidence && !gate.checked) {
        noEffect.push(gate.id + ": " + fields.join("/"));
      } else {
        doc.lines[gate.line] = doc.lines[gate.line].replace(/^- \[(x|X)\]/, "- [ ]");
        setEvidence(doc, gate, "pending");
        const insertAt = lastAttrLineAfter(doc, gate);
        doc.lines.splice(insertAt, 0,
          "  <!-- unidle: oracle changed (" + fields.join(", ") + "); prior evidence invalidated -->");
        invalidated.push(gate.id + ": " + fields.join("/"));
      }
    }
    if (invalidated.length || migrated.length) writeAtomic(newFile, formatDocument(doc));
    return { invalidated, migrated, noEffect };
  });

  for (const line of summary.invalidated) console.log("INVALIDATED " + line);
  for (const line of summary.migrated) console.log("MIGRATED " + line);
  for (const line of summary.noEffect) console.log("NO-EVIDENCE-AT-RISK " + line);
  if (!summary.invalidated.length && !summary.migrated.length && !summary.noEffect.length) {
    console.log("NO ORACLE CHANGES");
  }
  console.log("INVALIDATE SUMMARY: invalidated=" + summary.invalidated.length +
    " migrated=" + summary.migrated.length + " unevidenced=" + summary.noEffect.length);
}

// --------------------------------------------------------------- export

function commandExport(outDir, options) {
  const root = resolve(options.root || process.cwd());
  try {
    if (!statSync(root).isDirectory()) fail("--root is not a directory: " + root);
  } catch (error) {
    fail(error.code === "ENOENT" ? "--root does not exist: " + root : "cannot inspect --root: " + error.message);
  }
  const target = resolveTarget({ root, scope: options.scope, files: options.files });
  if (target.error) fail(target.error);
  if (!target.files.length) fail("no gate files found");

  let shell;
  try { shell = resolveShellOrThrow(); }
  catch (error) { fail(error.message); }
  const pathValue = String(process.env.PATH || "");
  const anchor = (gate, file) => {
    const base = target.mode === "explicit" ? dirname(resolve(file)) : root;
    return gate.cwd ? resolve(base, gate.cwd) : base;
  };
  const oracleOf = createOracle({
    shell, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, pathValue, resolveCwd: anchor,
  });

  const outFile = resolve(outDir, "unidle-evidence.jsonl");
  if (existsSync(outFile) && !options.force) fail(outFile + " exists; pass --force to overwrite");
  const lines = [JSON.stringify({
    type: "meta", tool: "gates-diff export", generatedAt: new Date().toISOString(),
    root, scope: target.scope ?? null, schema: 1,
  })];
  for (const file of target.files) {
    const doc = loadDoc(file, file);
    const relLedger = relative(root, resolve(file)).split(sep).join("/");
    for (const gate of doc.gates) {
      const oracleValue = oracleOf(file, gate);
      const signature = sha256(JSON.stringify(oracleValue));
      lines.push(JSON.stringify({
        type: "gate",
        ledger: relLedger,
        gate: gate.id,
        title: gate.title,
        state: gateState(gate, doc.abandoned),
        checked: gate.checked,
        evidence: gate.evidence,
        abandonedReason: doc.abandoned.get(gate.id) ?? null,
        oracle: { check: gate.check, expect: gate.expect, cwd: oracleValue.cwd },
        signature,
        approvalKey: sha256(resolve(file) + "\0" + gate.id + "\0" + signature),
      }));
    }
  }
  writeAtomic(outFile, lines.join("\n") + "\n");
  console.log("EXPORTED " + (lines.length - 1) + " gate(s) to " + outFile);
}

// ---------------------------------------------------------------- merge

function commandMerge(oldScope, newScope, options) {
  const root = resolve(options.root || process.cwd());
  for (const [label, value] of [["old-scope", oldScope], ["new-scope", newScope]]) {
    const error = validateScopeId(value, label);
    if (error) fail(error);
  }
  if (oldScope === newScope) fail("merge needs two different scopes");
  const scopes = listScopes(root);
  if (!scopes.includes(oldScope)) {
    fail("no such pipeline \"" + oldScope + "\" under .unidle/ (have: " + (scopes.join(", ") || "none") + ")");
  }
  const children = scopeFiles(root, oldScope);
  if (!children.length) fail("pipeline " + oldScope + " has no ledgers");

  const skillDir = dirname(fileURLToPath(import.meta.url));
  const gates = [];
  const skipped = [];
  for (const child of children) {
    const doc = loadDoc(child, child);
    const runnable = doc.gates.filter((gate) => gate.check && !doc.abandoned.has(gate.id));
    if (!runnable.length) { skipped.push(relative(root, child)); continue; }
    const stem = child.split(sep).pop().replace(/\.md$/i, "");
    const childRef = relative(root, child).split(sep).join("/");
    gates.push([
      "- [ ] " + stem + ": " + oldScope + "/" + stem + " holds (" + runnable.length + " runnable gates)",
      "  CHECK: node \"" + skillDir + "/gate-check.mjs\" --root . --reverify \"" + childRef + "\"",
      "  EXPECT: ALL MET",
    ].join("\n"));
  }
  if (!gates.length) fail("every ledger in " + oldScope + " lacks runnable gates; nothing to consolidate");

  const body = [
    "# Integration ledger",
    "",
    "Consolidates `" + oldScope + "` child verification into `" + newScope + "`. Each gate",
    "re-runs the child's runnable oracles through `gate-check --reverify`, so",
    "consolidated proof is re-executed, never inherited. Inspect every CHECK,",
    "approve with `gate-check --approve`, and run before reporting.",
    "",
    gates.join("\n\n"),
    "",
  ].join("\n");

  const outFile = resolve(root, ".unidle", newScope, "gates", "node-from-" + oldScope + ".md");
  if (existsSync(outFile) && !options.force) fail(outFile + " exists; pass --force to regenerate");
  writeAtomic(outFile, body, { root });
  console.log("MERGED " + gates.length + " child ledger(s) into " + outFile);
  for (const item of skipped) console.log("SKIPPED (no runnable gates): " + item);
  console.log("NEXT: gate-check --status --scope " + newScope + ", inspect, then --approve and run.");
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(args.length ? 0 : 2);
}
const command = args[0];
const { positional, flags } = parseArgs(args.slice(1));
const force = Boolean(flags.get("--force"));

if (command === "diff") {
  if (positional.length !== 2) fail("diff needs exactly OLD and NEW ledger files");
  await commandDiff(positional[0], positional[1]);
} else if (command === "invalidate") {
  if (positional.length !== 2) fail("invalidate needs exactly OLD and NEW ledger files");
  await commandInvalidate(positional[0], positional[1], parseAllowlist(flags.get("--migrate-ignore")));
} else if (command === "export") {
  if (!positional.length) fail("export needs a target directory");
  await commandExport(positional[0], {
    root: flags.get("--root"),
    scope: flags.get("--scope"),
    files: positional.slice(1),
    force,
  });
} else if (command === "merge") {
  if (positional.length !== 2) fail("merge needs exactly OLD_SCOPE and NEW_SCOPE");
  await commandMerge(positional[0], positional[1], { root: flags.get("--root"), force });
} else {
  fail("unknown command " + JSON.stringify(command));
}
