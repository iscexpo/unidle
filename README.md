# unidle: completion gates for AI coding agents

## Make autonomous software development verifiable.

`unidle` is a zero-dependency Node.js skill, CLI, and verification workflow for AI coding agents and substantial autonomous software development. It turns a vague "done" into an inspectable completion contract: define acceptance criteria, decompose work, run approved checks, re-verify evidence, and report what remains.

Use unidle for agentic coding workflows, multi-step implementation tasks, deep code reviews, release verification, and CI pipelines that need more than a green process exit.

<p align="center">
	<strong>PLAN</strong>
	&nbsp;→&nbsp;
	<strong>GATE</strong>
	&nbsp;→&nbsp;
	<strong>CHECK</strong>
	&nbsp;→&nbsp;
	<strong>REVERIFY</strong>
	&nbsp;→&nbsp;
	<strong>REPORT</strong>
</p>

```mermaid
graph LR
    A[Write outcomes] --> B[Build Depth Tree]
    B --> C[Claim ownership]
    C --> D[Run approved checks]
    D --> E[Record evidence]
    E --> F[Re-verify]
    F --> G[Integrate and report]
    F -.->|stale evidence| D
```

## Why unidle

Agents are good at producing activity. Activity is not completion.

Unidle makes the difference structural. A checked box without current evidence is still unmet. A command is not trusted merely because it exists. A successful leaf is not integrated until its parent verifies it again.

## Acceptance gates

Every gate is an observable outcome with an optional executable oracle:

```markdown
- [ ] G1: the release bundle contains no debug artifacts
	CHECK: node scripts/verify-release.mjs dist/
	EXPECT: release verification passed
	EVIDENCE: pending
```

The checker marks a runnable gate met only when the process exits `0` **and** `EXPECT:` matches combined output. It records the resolved shell, working directory, exit status, environment fingerprint, and decisive output.

Manual gates remain visible when automation cannot decide the outcome. Impossible work is handed off with `ABANDON:` rather than quietly erased.

## Quick start

Requires Node.js 16 or later. There are no runtime dependencies.

```bash
# 1. Create a ledger from the leaf template.
cp templates/gates-leaf.md GATES.md

# 2. Replace its placeholders, then lint the contract.
node scripts/gate-lint.mjs GATES.md

# 3. Inspect commands without executing them.
node scripts/gate-check.mjs --status GATES.md

# 4. Approve reviewed oracles and run the gates.
node scripts/gate-check.mjs --approve GATES.md
```

For a focused task, use **Solo** mode. For independent deliverables, create a Depth Tree with one ledger per leaf and branch, then use ownership leases and parent re-verification. The full workflow is in [`SKILL.md`](SKILL.md).

## Features and commands

| Surface | What it answers | Entry point |
| --- | --- | --- |
| Gate ledger | What does completion mean? | [`templates/gates-leaf.md`](templates/gates-leaf.md) |
| Linter | Can this oracle fail honestly? | `node scripts/gate-lint.mjs <ledger>` |
| Checker | What is met right now? | `node scripts/gate-check.mjs --status <ledger>` |
| Re-verification | Does old evidence still hold? | `node scripts/gate-check.mjs --reverify <ledger>` |
| Report | What should CI and reviewers see? | `node scripts/gate-report.mjs --summary` |
| Stop hook | Should an agent stop with gates unmet? | `node scripts/install-hooks.mjs` |

## Depth Trees

Use the smallest structure that exposes real boundaries:

```text
root task
├── branch: integration contract
│   ├── leaf: implementation
│   └── leaf: verification
└── branch: final integration
```

Each leaf owns explicit repository-relative paths. Each branch re-verifies its children, checks their interfaces, runs end-to-end integration, and checks regressions. Parallel dispatch changes wall-clock time; it does not lower the evidence standard.

Read [`references/method.md`](references/method.md) for decomposition and [`references/orchestration.md`](references/orchestration.md) for the driver loop.

## Trust boundary

`CHECK:` lines are shell code running with the checker's permissions and environment. Approval is explicit and bound to the exact command, expectation, ledger, gate, working directory, shell, timeout, limits, platform, and `PATH`.

The status command is read-only. A normal run without an exact approval prints the resolved oracle and leaves it unexecuted. Review inherited ledgers as source before approving them.

Scopes and leases coordinate cooperating workers; they are not a sandbox. Use operating-system, container, or virtual-machine isolation for untrusted commands. See [`SECURITY.md`](SECURITY.md).

## GitHub workflow

CI can publish the same ledger state as a step summary, Check Runs payload, or pull-request comment. Reporting never executes checks, approves oracles, or writes a ledger.

```yaml
- name: Report gate status
	if: always()
	run: node scripts/gate-report.mjs --summary --step-summary
```

Use `--check-runs --sha "$GITHUB_SHA"` to emit one required-check payload per ledger, or `--pr-comment` to publish a reviewer-friendly status table. See [`references/github.md`](references/github.md).

## Verify unidle

```bash
npm test
```

The test suite covers parsing, approvals, evidence, re-verification, concurrency, leases, the Stop hook, installer behavior, GitHub reporting, and portability boundaries.

## Documentation map

- [`SKILL.md`](SKILL.md): the core agent workflow
- [`references/gates.md`](references/gates.md): ledger format and oracle rules
- [`references/method.md`](references/method.md): Depth Tree method
- [`references/orchestration.md`](references/orchestration.md): branches, leaves, and integration
- [`references/parallel.md`](references/parallel.md): scopes, leases, and concurrent updates
- [`references/github.md`](references/github.md): CI summaries, Check Runs, and PR comments
- [`research/validation-protocol.md`](research/validation-protocol.md): historical limits and reproducible evaluation

## Contributing

Keep changes focused, portable, and backed by regression evidence. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md) before changing execution, approval, installer, or hook behavior.
