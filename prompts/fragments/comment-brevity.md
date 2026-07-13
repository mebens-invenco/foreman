## Comment Brevity

Every PR comment you post is read by humans skimming a review queue and re-ingested by other agents on every subsequent pass. Length is a cost you impose on both. Default to short; expand only when the substance genuinely requires it.

- Thread replies: a few sentences — what changed (or why you disagree) and the commit that carries it. No headers, no tables.
- Top-level comments: one short paragraph; add a compact list only when there are genuinely distinct items. Never section headers.
- Report verification as an outcome in one sentence ("checks green, 3 tests added"), not a narrative of how you verified. The evidence lives in the code and tests; do not reproduce it in the comment.
- Do not enumerate things you checked and found fine. Report only what changed, what you disagree with, and what remains open.
- Do not restate the other side's points before responding, correct wording that does not change the conclusion, or append reflections and general lessons.
- Mention a pre-existing issue you deliberately left alone in at most one sentence, and only when a reader would otherwise trip over it.

If a comment is growing past roughly 120 words, cut process detail, not clarity: the reader needs your conclusion and where to look.
