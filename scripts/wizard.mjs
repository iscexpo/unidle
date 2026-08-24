#!/usr/bin/env node
// Guided authoring for new pipeline ledgers: interviews for a scope name,
// ownership globs (overlap-checked against every existing declaration),
// optional cross-scope dependencies verified against live ledgers, and gates
// whose oracles are sampled through the real runner before anything is
// written. Zero dependencies. Node 16+.
//
//   node scripts/wizard.mjs [--root DIR] [--scope ID] [--from-json FILE]
//                           [--no-preview] [--shell PATH] [--timeout SECONDS]
//
// --from-json drives the identical validation, lint guard, and preview pass
// non-interactively, which makes the wizard scriptable and testable. The
// final text must parse cleanly, lint without errors, and survive every
// fail-closed check before it is atomically written to .unidle/<scope>/GATES.md.

import { createInterface } from "node:readline";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  UNIDLE_DIR, globsOverlap, listScopes, normalizeOwnsGlob, parseGates,
  scopeFiles, tail, validateScopeId, writeAtomic,
} from "./lib/gates.mjs";
import { lintDocument } from "./lib/lint-rules.mjs";
import { createRunner, DEFAULT_TIMEOUT_SECONDS, resolveShellOrThrow } from "./lib/runner.mjs";

const HELP = `usage: wizard.mjs [--root DIR] [--from-json FILE]
                  [--no-preview] [--shell PATH] [--timeout SECONDS]

Interviews you for a new pipeline ledger and writes .unidle/<scope>/GATES.md:

  scope name          validated like the checker validates --scope
  OWNS paths          each is overlap-checked against every existing
                      declaration in any other pipeline before acceptance
  NEEDS-SCOPE refs    scope:ledger-stem:gate-id entries, verified to exist;
                      a typo here would block the ledger forever
  gates               runnable (CHECK + EXPECT) or manual; runnable oracles
                      are sampled live so you see MET/UNMET before writing

The draft must pass the linter with zero errors; warnings are shown as notes.
Exit codes: 0 written (or deliberately aborted), 1 rejected draft, 2 usage.`;

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
    console.error("wizard: " + name + " needs a value");
    process.exit(2);
  }
  return value;
}

function usage(message) {
  console.error("wizard: " + message);
  process.exit(2);
}
function reject(problems) {
  for (const problem of problems) console.error("wizard: rejected: " + problem);
  console.error("wizard: nothing was written");
  process.exit(1);
}

const root = resolve(optionValue("--root") || process.cwd());
try {
  if (!statSync(root).isDirectory()) throw new Error("not a directory");
} catch (error) {
  usage("--root must be a directory (" + error.message + "): " + root);
}
const fromJson = optionValue("--from-json");
const noPreview = args.includes("--no-preview");
const timeoutRaw = optionValue("--timeout");
const timeoutSeconds = (() => {
  if (timeoutRaw === undefined) return DEFAULT_TIMEOUT_SECONDS;
  const value = Number(timeoutRaw);
  if (!Number.isInteger(value) || value < 1 || value > 3600) {
    usage("--timeout needs an integer seconds value from 1 through 3600");
  }
  return value;
})();

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ------------------------------------------------------------ spec intake

// One stdin line-source for the whole process. readline.question() drops
// buffered lines when answers arrive faster than prompts, so lines are
// queued here instead; EOF resolves prompts with "" which unwinds every
// loop and aborts the write.
let sharedRl = null;
const typedLines = [];
let lineWaiter = null;
let inputClosed = false;
function ensureLineSource() {
  if (sharedRl) return;
  sharedRl = createInterface({ input: process.stdin, output: process.stdout });
  sharedRl.on("line", (line) => {
    if (lineWaiter) {
      const done = lineWaiter;
      lineWaiter = null;
      done(line);
    } else typedLines.push(line);
  });
  sharedRl.on("close", () => {
    inputClosed = true;
    if (lineWaiter) {
      const done = lineWaiter;
      lineWaiter = null;
      done("");
    }
  });
}
function ask(prompt) {
  process.stdout.write(prompt);
  if (!inputClosed && !typedLines.length) {
    return new Promise((done) => { lineWaiter = done; });
  }
  return Promise.resolve(inputClosed ? "" : typedLines.shift());
}

async function interview() {
  ensureLineSource();
  try {
    console.log("unidle wizard — a new pipeline ledger (.unidle/<scope>/GATES.md)");
    const scope = (await ask("Scope name: ")).trim();
    const owns = [];
    for (;;) {
      const line = (await ask("OWNS path (empty to finish): ")).trim();
      if (!line) break;
      owns.push(line);
    }
    const needsRaw = (await ask("NEEDS-SCOPE references (comma-separated, empty to skip): ")).trim();
    const needsScope = needsRaw.split(",").map((item) => item.trim()).filter(Boolean);
    const gates = [];
    for (;;) {
      const id = (await ask("Gate id (empty to finish): ")).trim();
      if (!id) break;
      const title = (await ask("  outcome title (what a stranger could judge): ")).trim();
      const check = (await ask("  CHECK command (empty for a manual gate): ")).trim();
      let expect = "";
      let cwd = "";
      if (check) {
        expect = (await ask("  EXPECT string (or /pattern/): ")).trim();
        cwd = (await ask("  CWD relative to repo root (empty for root): ")).trim();
      }
      gates.push({ id, title, check: check || null, expect: expect || null, cwd: cwd || null });
      const accept = (await ask("  add this gate? [Y/n]: ")).trim();
      if (/^n/i.test(accept)) gates.pop();
    }
    return { spec: { scope, owns, needsScope, gates }, confirmed: false };
  } catch (error) {
    usage("interactive interview failed: " + error.message);
  }
}

function specFromJson(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    usage("--from-json " + file + " is not readable JSON: " + error.message);
  }
  const spec = {
    scope: String(raw.scope || "").trim(),
    owns: Array.isArray(raw.owns) ? raw.owns.map((item) => String(item).trim()).filter(Boolean) : [],
    needsScope: Array.isArray(raw.needsScope)
      ? raw.needsScope.map((item) => String(item).trim()).filter(Boolean)
      : [],
    gates: Array.isArray(raw.gates)
      ? raw.gates.map((gate) => ({
          id: String(gate.id || "").trim(),
          title: String(gate.title || "").trim(),
          check: gate.check ? String(gate.check).trim() : null,
          expect: gate.expect ? String(gate.expect).trim() : null,
          cwd: gate.cwd ? String(gate.cwd).trim() : null,
        }))
      : [],
  };
  return { spec, confirmed: true };
}

// ------------------------------------------------------------ validation

function referencePath(ref) {
  const [refScope, refStem] = ref.split(":");
  return refStem === "GATES"
    ? join(root, UNIDLE_DIR, refScope, "GATES.md")
    : join(root, UNIDLE_DIR, refScope, "gates", refStem + ".md");
}

function existingOwnsEverywhere(exceptScope) {
  const declarations = [];
  for (const name of listScopes(root)) {
    if (name === exceptScope) continue;
    for (const file of scopeFiles(root, name)) {
      const doc = parseGates(readFileSync(file, "utf8"));
      if (doc.owns.length) declarations.push({ scope: name, file, globs: doc.owns });
    }
  }
  return declarations;
}

function validateSpec(spec) {
  const scopeError = validateScopeId(spec.scope);
  if (scopeError) usage(scopeError);

  const existing = scopeFiles(root, spec.scope);
  if (existing.length) {
    usage("pipeline \"" + spec.scope + "\" already has a ledger (" +
      relative(root, existing[0]) + "); edit it directly instead of recreating it");
  }

  const problems = [];

  const owned = [];
  for (const raw of spec.owns) {
    const normalized = normalizeOwnsGlob(raw);
    if (normalized.error) problems.push("OWNS path rejected: " + normalized.error);
    else owned.push(normalized.value);
  }
  for (let i = 0; i < owned.length; i++) {
    for (let j = i + 1; j < owned.length; j++) {
      if (globsOverlap(owned[i], owned[j])) {
        problems.push("OWNS paths \"" + owned[i] + "\" and \"" + owned[j] + "\" overlap");
      }
    }
  }
  if (owned.length) {
    for (const declaration of existingOwnsEverywhere(spec.scope)) {
      for (const glob of owned) {
        const theirGlob = declaration.globs.find((other) => globsOverlap(glob, other));
        if (theirGlob) {
          problems.push("OWNS \"" + glob + "\" overlaps " +
            declaration.scope + "'s declaration \"" + theirGlob + "\" in " +
            relative(root, declaration.file));
        }
      }
    }
  }

  for (const ref of spec.needsScope) {
    const parts = ref.split(":").map((part) => part.trim());
    if (parts.length !== 3 || parts.some((part) => !part)) {
      problems.push("malformed NEEDS-SCOPE reference \"" + ref + "\"; expected scope:ledger-stem:gate-id");
      continue;
    }
    const [refScope, refStem, refGate] = parts;
    const scopeProblem = validateScopeId(refScope, "NEEDS-SCOPE scope");
    if (scopeProblem) { problems.push(ref + ": " + scopeProblem); continue; }
    if (!ID_RE.test(refStem)) { problems.push("NEEDS-SCOPE ledger stem must match " + ID_RE + ": " + ref); continue; }
    if (!ID_RE.test(refGate)) { problems.push("NEEDS-SCOPE gate id must match " + ID_RE + ": " + ref); continue; }
    const path = referencePath(ref);
    if (!existsSync(path)) {
      problems.push("NEEDS-SCOPE reference points at a missing ledger: " + ref +
        " (" + relative(root, path) + " does not exist)");
      continue;
    }
    const foreign = parseGates(readFileSync(path, "utf8"));
    if (foreign.errors.length) {
      problems.push("NEEDS-SCOPE reference points at an unparseable ledger: " + ref);
      continue;
    }
    if (!foreign.gates.some((gate) => gate.id === refGate)) {
      problems.push("NEEDS-SCOPE reference points at an unknown gate: " + ref);
    }
  }

  const seenIds = new Set();
  for (const gate of spec.gates) {
    if (!gate.id || !ID_RE.test(gate.id)) {
      problems.push("gate id must match " + ID_RE + ": " + (gate.id || "(blank)"));
      continue;
    }
    if (seenIds.has(gate.id)) problems.push("duplicate gate id " + gate.id);
    seenIds.add(gate.id);
    if (!gate.title) problems.push("gate " + gate.id + " needs a non-blank outcome title");
    if (Boolean(gate.check) !== Boolean(gate.expect)) {
      problems.push("gate " + gate.id + ": runnable gates need both CHECK and EXPECT " +
        "(or neither, for a manual gate)");
    }
    if (gate.cwd && /^\s*[A-Za-z]:[\\/]|^\s*\//.test(gate.cwd)) {
      problems.push("gate " + gate.id + ": CWD must be relative to the repository root");
    }
  }
  if (!spec.gates.length) problems.push("a ledger needs at least one gate");

  return problems;
}

// --------------------------------------------------------------- rendering

function renderLedger(spec) {
  const lines = [];
  for (const glob of spec.owns) lines.push("OWNS: " + glob);
  if (spec.needsScope.length) {
    if (lines.length) lines.push("");
    lines.push("NEEDS-SCOPE: " + spec.needsScope.join(", "));
  }
  for (const gate of spec.gates) {
    if (lines.length) lines.push("");
    lines.push("- [ ] " + gate.id + ": " + gate.title);
    if (gate.check) lines.push("  CHECK: " + gate.check);
    if (gate.expect) lines.push("  EXPECT: " + gate.expect);
    if (gate.cwd) lines.push("  CWD: " + gate.cwd);
  }
  return lines.join("\n") + "\n";
}

function lintGuard(text) {
  const doc = parseGates(text);
  const findings = lintDocument(doc);
  const errors = findings.filter((finding) => finding.level === "error");
  if (doc.errors.length || errors.length) {
    return { ok: false, doc, errors: [...doc.errors, ...errors.map((finding) =>
      finding.rule + ": " + finding.message)] };
  }
  return { ok: true, doc, errors: [], warnings: findings.filter((f) => f.level === "warn") };
}

// ---------------------------------------------------------------- preview

async function preview(doc) {
  const runnable = doc.gates.filter((gate) => gate.check);
  if (!runnable.length) return;

  let shell;
  try {
    shell = resolveShellOrThrow(optionValue("--shell"));
  } catch (error) {
    usage(String(error.message));
  }
  const runner = createRunner({ shell, timeoutSeconds });
  const ledgerPath = join(root, UNIDLE_DIR, spec.scope, "GATES.md");
  console.log("Previewing " + runnable.length + " runnable oracle" +
    (runnable.length === 1 ? "" : "s") + " (sample only; nothing is recorded):");
  for (const gate of runnable) {
    const cwd = gate.cwd ? resolve(root, gate.cwd) : root;
    const result = await runner.runCheck({ file: ledgerPath, gate, cwd });
    const outcome = "exit=" + (result.exitCode === null ? "none" : result.exitCode) +
      (result.signal ? " signal=" + result.signal : "") +
      "; EXPECT=" + (result.matched ? "matched" : "not matched") +
      "; output=" + tail(result.output);
    console.log("  PREVIEW " + gate.id + ": " + outcome);
    console.log("    -> sample verdict: " + (result.ok ? "MET" : "UNMET") +
      " (preview only; nothing recorded)");
  }
}

// ------------------------------------------------------------------- main

const loaded = fromJson ? specFromJson(fromJson) : await interview();
const spec = loaded.spec;

const problems = validateSpec(spec);
if (problems.length) reject(problems);

const text = renderLedger(spec);
const guarded = lintGuard(text);
for (const warning of guarded.warnings || []) {
  console.log("note (" + warning.rule + "): " + warning.message);
}
if (!guarded.ok) reject(guarded.errors);

const ledgerLabel = join(UNIDLE_DIR, spec.scope, "GATES.md");
console.log("Draft for " + ledgerLabel + ": " +
  spec.gates.length + " gate(s), " + spec.owns.length + " OWNS path(s)" +
  (spec.needsScope.length ? ", depends on " + spec.needsScope.join(", ") : ", no dependencies"));

if (!noPreview) await preview(guarded.doc);

if (!loaded.confirmed) {
  ensureLineSource();
  const answer = await ask("Write this ledger? [y/N]: ");
  if (!/^y/i.test(String(answer).trim())) {
    console.log("Aborted; nothing was written.");
    process.exit(0);
  }
}

const ledgerPath = join(root, UNIDLE_DIR, spec.scope, "GATES.md");
writeAtomic(ledgerPath, text, { root });
console.log("WROTE " + ledgerLabel);
console.log("next: node gate-check.mjs --status --scope " + spec.scope);
