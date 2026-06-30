# Judge calibration — learning-policy `quality`

Evidence behind the calibration numbers in `../README.md`. The `quality` judge
(`graders.ts` `judgeGrader`) answers one binary question about a recorded learning:
*is it worth keeping for future agents — a generalizable rule, or a one-off?* It is
**advisory** (never gates a sample) and must clear an agreed agreement bar against
human labels before it ever could.

`results.json` is the per-item record (human label, judge verdict, rationale) for
the shipped judge.

## Method (ENG-5342)

1. **Source.** Mined 244 retained `(rendered prompt, model output)` pairs from the
   live `automation-pilot` workspace; extracted the 30 `add` learning mutations the
   judge actually grades (it scores `add`s only).
2. **Label.** Each add labelled reusable yes/no under a **strict** bar. Labels are
   agent-proposed under the human-ratified bar — provisional ground truth, not
   independent per-item human annotation. 25 positives / 5 negatives.
3. **Hard negatives + held-out.** Added 6 *constructed* clearly-junk learnings, and
   a *held-out* validation set of fresh narrow one-offs (5) + broadly-transferable
   rules (4) to test the judge on UNAMBIGUOUS cases it wasn't tuned against.
4. **Judge.** Ran the production `buildJudgePrompt` (imported, not copied) on
   **claude-sonnet-4-6** with MCP disabled (`--strict-mcp-config`).

> **Model caveat.** These numbers characterise the judge *prompt* on
> **sonnet-4-6** — not the default judge *model*. The judge runs on the eval's
> execution-runner config, whose default is `opencode / openai/gpt-5.5`, so the
> default-config judge is **not** what was calibrated here. Reproduce these numbers
> with `--runner claude --model claude-sonnet-4-6`; calibrating the default model is
> separate work.

`R23` (`PDP8V2::Use plain useQuery…`) is **excluded from the real-negative TNR**: it
was wrong-at-recording (a later run corrected it). The judge grades reusability, not
factual correctness, so it cannot and should not catch that.

## Result (shipped judge)

| | rate | note |
|---|---|---|
| TPR real positives | 25/25 = 100% | no false-negatives on real learnings, incl. the 4 empirically-reused ones |
| TNR real negatives (R23 excl.) | 0/4 = 0% | see "labeling artifact" below |
| TNR constructed hard-negatives | 6/6 = 100% | |
| TNR held-out negatives | 4/5 = 80% | validation: clear one-off facts/configs/incidents |
| TPR held-out positives | 4/4 = 100% | validation: clear broadly-transferable rules |

## What the calibration actually showed

- **The judge has real discriminative power.** On unambiguous ground truth it scores
  6/6 (constructed) + 4/5 (held-out one-offs) + 4/4 (held-out positives) = 14/15.
- **The 0/4 real-negative TNR is largely a labeling artifact, not a broken judge.**
  Read the four rationales in `results.json`: the "negatives" are *defensibly
  reusable* (a repo gitignore gotcha that recurs, a multi-item-editor invariant, a
  review decision rule). The strict bar was harsher than a reasonable reading.
- **A content-judge can't reliably detect over-eagerness.** Over-eager learnings are
  *written* to read as reusable, so a judge reading the content mostly agrees. The
  durable over-eager signal is **empirical reuse** — only 4/30 stored learnings were
  ever applied (`applied_count > 0`).
- **A blunt "must be broadly transferable" prompt backfires.** An earlier v2 version
  cratered TPR to 17/25 by rejecting repo-internal-but-reusable rules (incl. two
  empirically-reused), for no real-negative gain. The shipped v3 targets *one-off
  facts*, not *repo-specificity*.

## Status & next

The judge stays **advisory**. To gate it would need a larger, **independently**
human-annotated negative set (the current labels are agent-proposed) and an agreed
TNR bar — and likely an empirical-reuse signal alongside the content-judge, since
content alone can't separate persuasively-written over-eager learnings from genuinely
reusable ones.

That labeling round is underway (ENG-5444 track): [`lp-judge-labeler.html`](./lp-judge-labeler.html)
is a self-contained offline labeling bench over the 88 learning `add`s in the current
harvest (vs 30 in this calibration). Open it in Chrome, set your labeler name, label
each item `reusable` / `one-off` / `unsure` (keyboard: R/O/U, autosaves locally), and
export `lp-judge-labels-<name>.json` with the write-to-disk button. Multiple labelers
export separate files; agreement analysis adjudicates. Labelers must not read
`results.json` or re-run the judge before finishing — independence is the point.

## Re-running

The judge *prompt* lives in `graders.ts`; the *model* is supplied by the eval runner
at invocation (pin it with `--runner claude --model claude-sonnet-4-6` to match this
run — the default is gpt-5.5). Rebuild the labelled set from retained worker artifacts,
then run the judge per item with MCP disabled. Re-calibrate whenever the judge prompt,
the judge model, or the learning-policy fragment changes.
