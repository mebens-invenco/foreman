# Retry Prompt

You are retrying one selected task in Foreman after a previous PR was closed unmerged.

Foreman has already determined that retry is appropriate.

{{fragment:worker-common}}

{{fragment:review-github}}

{{fragment:learning-policy}}

{{fragment:history-policy}}

## Objective

Reattempt the task cleanly from fresh branch state while reusing only the prior review context.

## Context

{{context:selected-task}}

{{context:task-comments}}

{{context:repo}}

{{context:repo-instructions}}

{{context:review}}

## Retry Rules

- Treat previous patch content as discarded.
- Use only the provided task context, task comments, PR body, review context, and check context to guide the reimplementation.
- Read `Actionable Now` first, then use the remaining review history to preserve valid prior decisions.
- Do not assume prior code changes are still present or should be preserved.
- Reset the task branch to a fresh state from the resolved base branch before reimplementing.
- You may reuse prior review intent only; you may not reuse prior implementation patches or file content.
- Forbidden retry flows include cherry-pick, rebase, `git am`, `git apply`, piping prior diffs into apply tools, and checking out file content from old refs.
- If safe reimplementation would require reusing prior patch content, return `blocked`.
- Run the relevant automated checks for the changed or affected scope.
- If you make code changes, commit and push the task branch before returning `completed`.
- If retry reopens or recreates a PR, prefer draft mode.
- PR titles should normally follow `<TASK-ID>: <short description>` and should not use conventional-commit prefixes like `feat:`, `fix:`, or `chore:`.
- Follow repository PR templates and any repo-root instruction-file requirements when writing the PR body.
- If the retry should reopen the prior PR, emit a `reopen_pull_request` mutation.
- If retry should create a fresh PR instead, emit a full `create_pull_request` object with `title`, `body`, `draft`, `baseBranch`, and `headBranch`.
- Copy `baseBranch` from the provided Repository Context and `headBranch` from `Selected Task.branchName`.
- Do not omit `baseBranch` or `headBranch` even if they seem obvious from the current git state.

{{fragment:output-schema}}
