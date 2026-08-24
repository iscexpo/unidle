#!/usr/bin/env node
// Render unidle gate status as GitHub artifacts: a Step Summary table, Check
// Runs payloads, or a PR comment body. Status only: this never executes a
// CHECK, never approves an oracle, and never writes a ledger. CI verifies;
// humans approve. Zero dependencies. Node 16+.
//
// exit codes: 0 all met; 1 unmet; 2 usage/parse/infrastructure.

import { appendFileSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gateState, parseGates, resolveTarget, validateScopeId } from "./lib/gates.mjs";

const HELP = `usage: gate-report.mjs --summary|--check-runs|--pr-comment [options] [file ...]

render modes (exactly one):
  --summary             markdown status table (Step Summary shape)
  --check-runs          Check Runs API JSON array, one entry per ledger
  --pr-comment          markdown PR comment body

options:
  --step-summary        with --summary: append to \$GITHUB_STEP_SUMMARY
  --sha REF             with --check-runs: head sha (\$GITHUB_SHA)
  --scope ID            use .unidle/ID (or UNIDLE_SCOPE)
  --root DIR            repository/pipeline root (default current directory)
  file ...              explicit regular ledger files

Reads ledgers through the shared parser. Never executes, approves, or writes.
Check-run names are "unidle / <ledger>"; register them as required status
checks to block merges with incomplete work.`;

function parseArgs(argv) {
  const flags = new Set(["--summary", "--check-runs", "--pr-comment", "--step-summary", "--help", "-h"]);
  const values = new Set(["--sha", "--scope", "--root"]);
  const options = {};
  const files = [];
  let positional = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") { positional = true; continue; }
    if (!positional && flags.has(arg)) {
      const key = arg.replace(/^-+/, "").replace(/-/g, "_");
      if (options[key] !== undefined) return { error: "duplicate option " + arg };
      options[key] = true;
      continue;
    }
    if (!positional && arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (!values.has(name)) return { error: "unknown option " + name };
      const key = name.slice(2).replace(/-/g, "_");
      if (options[key] !== undefined) return { error: "duplicate option " + name };
      const value = equals === -1 ? argv[++index] : arg.slice(equals + 1);
      if (value === undefined || value === "") return { error: name + " needs a value" };
      options[key] = value;
      continue;
    }
    if (!positional && arg.startsWith("-")) return { error: "unknown option " + arg };
    files.push(arg);
  }
  return { options, files };
}

function failUsage(message) {
  console.error("gate-report: " + message);
  console.error("run gate-report.mjs --help for usage");
  process.exit(2);
}

const parsedArgs = parseArgs(process.argv.slice(2));
if (parsedArgs.error) failUsage(parsedArgs.error);
const { options: opt, files: fileArgs } = parsedArgs;

if (opt.help || opt.h) {
  console.log(HELP);
  process.exit(0);
}

const modes = ["summary", "check_runs", "pr_comment"].filter((key) => opt[key]);
if (modes.length !== 1) {
  failUsage("choose exactly one render mode: --summary, --check-runs, or --pr-comment");
}
const mode = modes[0];
if (opt.step_summary && mode !== "summary") failUsage("--step-summary is only valid with --summary");
if (opt.sha && mode !== "check_runs") failUsage("--sha is only valid with --check-runs");

const root = resolve(opt.root || process.cwd());
try {
  if (!statSync(root).isDirectory()) failUsage("--root is not a directory: " + root);
} catch (error) {
  failUsage(error.code === "ENOENT" ? "--root does not exist: " + root : "cannot inspect --root " + root + ": " + error.message);
}

if (opt.scope) {
  const error = validateScopeId(opt.scope);
  if (error) failUsage(error);
}

const UNIDLE_DIR_HINT = ".unidle/<scope>/, then GATES.md and gates/*.md";
const target = resolveTarget({ root, scope: opt.scope, files: fileArgs });
if (target.error) failUsage(target.error);
if (!target.files.length) failUsage("no gate files found (looked for " + UNIDLE_DIR_HINT + " under " + root + ")");
for (const file of target.files) {
  try {
    if (!statSync(file).isFile()) failUsage("gate target is not a regular file: " + file);
  } catch (error) {
    failUsage(error.code === "ENOENT" ? "no such gate file: " + file : "cannot inspect gate file " + file + ": " + error.message);
  }
}

function loadLedger(file) {
  let text;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { failUsage("cannot read " + file + ": " + error.message); }
  const doc = parseGates(text);
  if (doc.errors.length) {
    for (const error of doc.errors) console.error("gate-report: " + file + ": " + error);
    process.exit(2);
  }
  return doc;
}

function ledgerReport(file, doc) {
  const stem = basename(file).replace(/\.md$/i, "");
  const label = (target.mode === "scope" && target.scope ? target.scope + "/" : "") + stem;
  const met = [];
  const unmet = [];
  const abandoned = [];
  for (const gate of doc.gates) {
    const state = gateState(gate, doc.abandoned);
    if (state === "met") met.push(gate);
    else if (state === "abandoned") abandoned.push({ gate, reason: doc.abandoned.get(gate.id) || "" });
    else unmet.push({ gate, pendingEvidence: state === "unmet-no-evidence" });
  }
  return {
    file, label, stem, total: doc.gates.length,
    metCount: met.length, unmetCount: unmet.length, abandonedCount: abandoned.length,
    unmet, abandoned,
    ok: unmet.length === 0,
  };
}

const reports = target.files.map((file) => ledgerReport(file, loadLedger(file)));
const scopeSuffix = target.mode === "scope" && target.scope ? " [scope " + target.scope + "]" : "";
const anyUnmet = reports.some((report) => !report.ok);

// Markdown cells: a raw pipe breaks the table, a newline breaks the row.
function cell(value) {
  return String(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function qualified(report, id) {
  return "`" + cell(report.stem) + ":" + cell(id) + "`";
}

function unmetLines(report) {
  return report.unmet.map(({ gate, pendingEvidence }) =>
    "- " + qualified(report, gate.id) + " — " + cell(gate.title) +
    (pendingEvidence ? " (checked but EVIDENCE pending)" : ""));
}

function abandonedLines(report) {
  return report.abandoned.map(({ gate, reason }) =>
    "- " + qualified(report, gate.id) + " — " + cell(reason));
}

function totalsLine(report) {
  const parts = [report.metCount + " met"];
  if (report.abandonedCount) parts.push(report.abandonedCount + " abandoned");
  return report.ok
    ? "**ALL MET (" + parts.join(", ") + ")**"
    : "**UNMET: " + report.unmetCount + " (met: " + report.metCount +
      (report.abandonedCount ? ", abandoned: " + report.abandonedCount : "") + ")**";
}

function detailSections(report) {
  const blocks = [];
  if (report.unmet.length) {
    blocks.push("### Unmet\n" + unmetLines(report).join("\n"));
  }
  if (report.abandoned.length) {
    blocks.push("### Abandoned\n" + abandonedLines(report).join("\n"));
  }
  return blocks.join("\n\n");
}

function renderSummary() {
  const heading = "## 🧾 Unidle gates — " +
    (target.mode === "scope" && target.scope ? "scope `" + target.scope + "`" : "standalone ledgers");
  const table = [
    "| Ledger | Gates | Met | Unmet | Abandoned | Result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...reports.map((report) =>
      "| " + cell(report.label) + " | " + report.total + " | " + report.metCount + " | " +
      report.unmetCount + " | " + report.abandonedCount + " | " + (report.ok ? "✅" : "❌") + " |"),
  ].join("\n");
  const details = reports.map(detailSections).filter(Boolean).join("\n\n");
  const footer = totalsLine(reports.find((report) => !report.ok) || reports[reports.length - 1]) + scopeSuffix;
  return [heading, table, details, footer].filter(Boolean).join("\n\n");
}

function renderPrComment() {
  return renderSummary() +
    "\n\n_Status-only report from unidle gate-report.mjs: checks were never executed here. Run evidence lives in each ledger._";
}

function renderCheckRuns(sha) {
  return reports.map((report) => ({
    name: "unidle / " + report.label,
    head_sha: sha,
    status: "completed",
    conclusion: report.ok ? "success" : "failure",
    output: {
      title: report.ok
        ? "ALL MET (" + report.metCount + " met" + (report.abandonedCount ? ", " + report.abandonedCount + " abandoned" : "") + ")"
        : "UNMET: " + report.unmetCount + " (met: " + report.metCount +
          (report.abandonedCount ? ", abandoned: " + report.abandonedCount : "") + ")",
      summary: report.total + " gates: " + report.metCount + " met, " + report.unmetCount +
        " unmet, " + report.abandonedCount + " abandoned." + scopeSuffix,
      text: detailSections(report) || "All runnable gates hold; no findings.",
    },
  }));
}

let rendered = "";
if (mode === "summary") rendered = renderSummary();
if (mode === "pr_comment") rendered = renderPrComment();
if (mode === "check_runs") {
  const sha = opt.sha || process.env.GITHUB_SHA || "";
  if (!sha) failUsage("--check-runs needs --sha REF or GITHUB_SHA in the environment");
  rendered = JSON.stringify(renderCheckRuns(String(sha)), null, 2);
}

if (opt.step_summary) {
  const stepPath = process.env.GITHUB_STEP_SUMMARY;
  if (!stepPath) failUsage("--step-summary needs GITHUB_STEP_SUMMARY in the environment");
  try {
    appendFileSync(stepPath, rendered + "\n");
  } catch (error) {
    console.error("gate-report: cannot append to " + stepPath + ": " + error.message);
    process.exit(2);
  }
  console.error("gate-report: appended summary to " + stepPath);
} else {
  console.log(rendered);
}

process.exit(anyUnmet ? 1 : 0);
