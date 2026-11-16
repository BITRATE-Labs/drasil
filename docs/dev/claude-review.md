# Claude PR Review

Drasil runs an automatic, advisory pull request reviewer, Basic PR Review, for
trusted same-repository PRs targeting `main`. The caller is
`.github/workflows/basic-pr-review.yml`, which calls BASIC's shared reusable
workflow in [`BITRATE-Labs/basic-pr-review`](https://github.com/BITRATE-Labs/basic-pr-review)
at its `v1` tag. The model is Claude. The reviewer's logic, limits, prompt and
publishing live in that repository, and a reviewer release reaches Drasil
without any change here, so its
[README](https://github.com/BITRATE-Labs/basic-pr-review#readme) is the
reference for current behavior.

## Setup

The canonical Claude Code subscription OAuth token lives in BASIC's AWS Secrets
Manager secret `/basic/shared/claude-code-oauth-token` in `us-east-2`. The
shared workflow uses GitHub OIDC to assume the narrowly scoped
`basic-shared-claude-github-review` role and retrieves that one secret at
runtime. Drasil has no repository copy to rotate. The role and its trust are
owned in `BASIC-BIT/basic-infra` (`docs/shared-claude-oauth.md`).

The token consumes the subscription's Claude Code quota and rate limits rather
than Anthropic API token billing.

The repository labels `skip-pr-review`, `skip-claude-review` and
`request-pr-review` exist so maintainers can skip or request a review.

## Triggers

- Open, push, reopen, mark ready for review, or retarget a trusted
  same-repository, non-draft pull request, or remove a skip label.
- Drafts are reviewed only on request: add `request-pr-review` to an open pull
  request, draft or not, to review its current head. The label is removed after
  the review publishes.
- Add `skip-pr-review` or the older `skip-claude-review` to skip review.

Fork, cross-repository and bot-authored pull requests are skipped.

## Output

The shared workflow owns one sticky top-level comment headed "Basic PR Review"
(marker `basic-pr-review`). It names the head and base it reviewed, and
line-specific findings use file and line references in that comment rather
than independent review threads. It also sets a `basic-pr-review` commit status
on the PR head: success when a review is published or the PR is exempt, failure
when the review ran and did not complete, and nothing (pending) while
unreviewed. The status is not a required check. Treat a failed review as
missing review evidence rather than code feedback.

## Review Calibration

`REVIEW.md` is the repo-specific review contract, read from the trusted base
commit, so a PR's edits to it are reviewed as diff content but cannot calibrate
their own review. Keep it short and focused on what changes Claude's behavior:
Important severity, noise suppression, evidence quality, and Drasil moderation
invariants. Do not duplicate all of `AGENTS.md`.

Treat Claude comments like other AI review feedback: validate each finding
against the code and product intent before changing anything. After every push,
reread the sticky comment because the workflow updates it in place.
