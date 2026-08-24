# Changelog

Notable user-visible changes. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver. Releases before 2.2.0 are summarized in commit history rather than retroactively listed here.

## [Unreleased]

### Fixed

- `gate-lint.mjs` prints `LINT OK` whenever nothing failed. Advisory warnings no longer suppress the pass token, so the documented self-lint pattern (`EXPECT: LINT OK`) passes on ledgers that carry warnings; they are listed on an extra `LINT ADVISORIES:` line instead.
- `references/parallel.md`: corrected the `NEEDS-SCOPE` example to use bare ledger stems (`infra:leaf-2.1:g1`); stems cannot contain slashes or extensions.
- `SKILL.md`: `gate-report.mjs` render modes are mutually exclusive; documented valid invocations instead of an impossible combination, and stopped describing all companions as stateless (`gates-diff invalidate/export/merge` write by design).
- `templates/gates-leaf.md`: ships five live gates so filled-in copies satisfy the five-gate minimum the template itself states.

### Added

- Security model coverage for the two newest surfaces: the dashboard TCP server (bind exposure, no auth, same-origin readability) and the wizard's approval-free preview execution.

## [2.2.0] - 2026-08-24

### Added

- Multi-scope pipelines: `NEEDS-SCOPE` cross-scope dependencies, `--scope-tree` recursive dispatch, nested scope ids (`team/sub/leaf`, max depth 8), and cross-scope lease-conflict detection wherever leases are reported.
- Ledger authoring: `wizard.mjs` interactive interview plus `--from-json` batch mode with shared validate → render → lint-guard → preview → confirm flow and atomic writes.
- Inspection: `dashboard.mjs` read-only local server (loopback default) for gate trees, evidence, status timelines, lease conflicts, and exports; `gate-report.mjs` CI rendering (`--summary`, `--pr-comment`, `--check-runs`, JSON).
- Maintenance: `gates-diff.mjs` (`diff|invalidate|export|merge`) for moving ledgers between scopes without losing evidence trails.
- Docs: `references/github.md` integration guide; skill surface updated for every new feature.
