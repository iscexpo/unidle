# GitHub integration

Make gate verification native to the pull-request workflow. The principle is
the same one unidle applies everywhere else: **CI verifies, humans approve.**
`gate-report.mjs` is status-only — it never executes a `CHECK:`, never records
an approval, and never writes a ledger.

```text
node scripts/gate-report.mjs --summary [file ... | --scope ID]
node scripts/gate-report.mjs --pr-comment [file ... | --scope ID]
node scripts/gate-report.mjs --check-runs --sha REF [file ... | --scope ID]
```

Exit codes mirror the checker: 0 all met, 1 unmet, 2 usage/parse error. A
pipeline whose ledgers cannot be parsed fails closed at 2 and never reports a
green run.

## Step Summary

Append the status table to `$GITHUB_STEP_SUMMARY` so every job page shows
which gates are met, unmet, or abandoned:

```yaml
- name: Gate status
  run: node scripts/gate-report.mjs --summary --step-summary
```

Without `--step-summary` the markdown goes to stdout, so you can also redirect
it yourself (`>> "$GITHUB_STEP_SUMMARY"`) or paste it anywhere.

## Check runs

Emit one Check Runs API object per ledger, named `unidle / <ledger>`, with
conclusion `success` only when every live gate in that ledger is met.
Abandoned gates are surfaced in the output text but do not fail the run,
matching checker semantics. Create the checks by looping over the payload:

```yaml
- name: Report check runs
  if: always()
  uses: actions/github-script@v7
  with:
    script: |
      const { execSync } = require("node:child_process");
      const runs = JSON.parse(execSync(
        "node scripts/gate-report.mjs --check-runs --sha " + process.env.GITHUB_SHA,
        { stdio: ["ignore", "pipe", "inherit"] },
      ).toString());
      for (const run of runs) {
        await github.rest.checks.create({ ...context.repo, ...run });
      }
```

To block merges on incomplete work, mark each `unidle / …` check as a
required status check under Settings → Branches → Branch protection. Pin
`--scope` in CI when several pipelines exist; the checker's refusal to guess
between ambiguous scopes is preserved here as exit 2.

## PR comments

Post (or update) a comment containing the same table plus abandonment
reasons. Re-running and replacing your own comment beats accumulating one
comment per push:

```yaml
- name: Comment gate status
  if: always()
  env:
    GH_TOKEN: ${{ github.token }}
  run: |
    body=$(node scripts/gate-report.mjs --pr-comment)
    gh pr comment "$PR_NUMBER" --body "$body" --repo "$GITHUB_REPOSITORY"
```

## What this integration deliberately does not do

- It does not approve oracles. Approval remains a local, human act recorded
  outside the repository; a green check run means *status is clean*, and
  status is only clean when evidence exists for every checked gate.
- It does not execute checks to produce a report. Evidence comes from
  ledgers already updated by `gate-check`.
- It does not trust the report alone for merges: required check runs are the
  enforcement point, and they are derived from the same parsed ledgers the
  local tools see.
