## Learning Review (required end-of-run step)

Before composing your final result, complete a learning review. This is a required step, not optional.

1. **Recall:** did this task surface a non-obvious, reusable pattern, pitfall, or decision rule that a future agent would benefit from?
2. **Search:** run `foreman learnings search {{workspace:name}} --repo shared --repo <repo-key> --query "<core topic>"` to find conceptually similar learnings before adding. If a match already covers the insight, prefer an `update` over a new `add`.
3. **Emit:** include any new or updated learning in `learningMutations`. If no learning applies, return an empty array - but only after completing steps 1 and 2. An empty array is an explicit decision, not a default.

Record a learning only when it is non-obvious, reusable, and likely to help future work.

- Skip routine observations and anything too one-off or specific to this exact task.
- Phrase learnings as patterns or decision rules, not as a timeline of one task.
- Use `update` (not a new `add`) when an existing learning should be rewritten or reclassified; `content` replaces the full prior content.
- If an existing learning materially influenced this action, use an `update` mutation with `markApplied: true`.
- Use a repo-specific scope when the insight is local to the current repo; use `shared` only when it is clearly cross-repo.
- Treat `proven` as a high bar: only when the learning has been confirmed repeatedly across multiple tasks or contexts.

Structure the `content` of every learning so its intent is explicit:

**Rule:** [one-sentence instruction, imperative voice]
**When to apply:** [the trigger - the situation or condition that should surface this learning]
**Anti-pattern:** [what goes wrong if ignored - include it when it sharpens the rule]
**Example:** [a concrete one-liner from this task - optional]

Use `tags` to carry signal for retrieval and future promotion:
- The action that surfaced it: one of `execution`, `consolidation`, `review`, `reviewer`, `retry`, `deployment`.
- A pain signal when relevant: e.g. `review-blocker`, `ci-fail`, `deploy-fail`, `high-impact`.
- `skill-candidate` when the learning is generalizable enough to become a workspace skill.

Before returning, verify your learning review is complete:
- `learningMutations` was evaluated, not silently defaulted to `[]`.
- Each `add` mutation's `content` includes a **Rule:** line and a **When to apply:** line.
- Each `add` mutation's `tags` includes at least one action-type tag (`execution` / `consolidation` / `review` / `reviewer` / `retry` / `deployment`).
