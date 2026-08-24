// exit codes: 0 nothing failed, 1 failures (errors, or warnings under
// --strict), 2 usage or parse error.
//
// Usable as a gate, so a ledger can require its own quality:
//   CHECK: node scripts/gate-lint.mjs GATES.md
//   EXPECT: LINT OK

import { readFileSync } from "node:fs";
import { parseGates } from "./lib/gates.mjs";
import { lintDocument } from "./lib/lint-rules.mjs";

const HELP = `usage: gate-lint.mjs [--strict] [--json] <ledger.md ...>

Audit gate quality, not gate completion. Report oracles that cannot fail,
expectations satisfied by their own command, titles that name an activity
instead of an outcome, and ledgers outside the size band in
references/gates.md. Never executes a CHECK.

exit codes: 0 nothing failed, 1 failures, 2 usage or parse error.`;

const KNOWN_OPTIONS = new Set(["--strict", "--json", "--help", "-h"]);

const args = process.argv.slice(2);
if (!args.length) {
  console.error(HELP);
  process.exit(2);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
for (const arg of args) {
  if (arg.startsWith("--") && !KNOWN_OPTIONS.has(arg)) {
    console.error("gate-lint: unknown option " + arg);
    console.error("run gate-lint.mjs --help for usage");
    process.exit(2);
  }
}
const strict = args.includes("--strict");
const asJson = args.includes("--json");
const files = args.filter((a) => !a.startsWith("-"));
if (!files.length) {
  console.error("gate-lint: name at least one ledger file");
  process.exit(2);
}

const findings = [];
const add = (file, level, gate, rule, message) =>
  findings.push({ file, level, gate: gate || null, rule, message });

let parseFailed = false;

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    console.error("gate-lint: cannot read " + file + ": " + error.message);
    process.exit(2);
  }

  const doc = parseGates(text);
  if (doc.errors.length) {
    // A ledger the shared parser rejects cannot be judged on quality.
    parseFailed = true;
    for (const error of doc.errors) add(file, "error", null, "parse", error);
    continue;
  }

  for (const finding of lintDocument(doc)) findings.push({ file, ...finding });
}

const errors = findings.filter((f) => f.level === "error");
const warnings = findings.filter((f) => f.level === "warn");
const failed = errors.length > 0 || (strict && warnings.length > 0);

if (asJson) {
  console.log(JSON.stringify({
    ok: !failed,
    errors: errors.length,
    warnings: warnings.length,
    findings,
  }, null, 2));
} else {
  let lastFile = null;
  for (const finding of findings) {
    if (finding.file !== lastFile) {
      console.log(finding.file);
      lastFile = finding.file;
    }
    const label = finding.level === "error" ? "ERROR" : "WARN ";
    const who = finding.gate ? finding.gate + ": " : "";
    console.log("  " + label + " " + who + finding.message + "  [" + finding.rule + "]");
  }
  console.log(findings.length
    ? "LINT FINDINGS: " + errors.length + " error(s), " + warnings.length + " warning(s)"
    : "LINT OK");
}

process.exit(parseFailed ? 2 : failed ? 1 : 0);