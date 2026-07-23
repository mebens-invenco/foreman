<!--
Verbosity audit of the rendered reviewer-action prompts (reviewer.md +
reviewer-continuation.md), method: rank sections by rendered token cost, then
use the conformance data in ./reviewer-error-analysis.md (112 non-legacy
traces) to decide cuts — rules that hold at 100% get compressed, rules that
leak stay verbatim. Companion to reviewer-error-analysis.md and
summary-policy-error-analysis.md.
-->

# reviewer prompt verbosity audit

A rendered first-pass reviewer prompt is ~798 lines / ~3,400 words / ~29k
static chars (≈7.5k tokens) before per-task context JSON. This audit ranks
where those tokens go and decides, section by section, what can shrink
without touching a rule the trace corpus shows is load-bearing.

Invariant preserved throughout (e3d7992): continuation templates re-ground
every behavioral fragment the first pass includes. Cuts shorten **fragment
content**; they never drop a fragment from a continuation template.

## Cost ranking (first-pass `reviewer.md`, static content = 28,946 chars)

| rank | section | chars | share | conformance evidence (reviewer-error-analysis.md) |
|---|---|---|---|---|
| 1 | `{{context:result-schema}}` (inlined JSON Schema) | 12,861 | 44% | 100% — zero mutation/outcome inconsistencies, 23/23 structural conformance |
| 2 | `review-github` fragment | 4,434 | 15% | 100% on every rule that applies to reviewer; most rules don't apply (see below) |
| 3 | `learning-policy` fragment | 2,638 | 9% | not graded in this corpus |
| 4 | `reviewer.md` own body (Reviewer Rules etc.) | ~2,000 | 7% | findings-in-thread **leaks 3/23** |
| 5 | `worker-common` fragment | 1,703 | 6% | 0 wrong verdicts, 0 direct mutations |
| 6 | `task-system-linear-worker` fragment | 1,482 | 5% | not graded |
| 7 | `comment-brevity` fragment | 1,269 | 4% | shipped post-corpus (PR #129) — no data yet |
| 8 | `reviewer-audience` fragment | 1,250 | 4% | findings-in-body **leaks 3/23**; thread-count discipline holds (median 1, max 4) |
| 9 | `output-validator` fragment | 695 | 2% | 100% |
| 10 | `summary-policy` fragment | 243 | 1% | the strongest fragment in the corpus: present → max 363c, absent → p95 566c |

The continuation prompt is ~23.2k static chars, of which the schema +
review-github are 17.3k (**75%**). Because `review-github` renders in 7
templates and re-renders on every continuation pass, its cost compounds
across a task lifecycle in a way the one-shot templates' bodies do not.

## Decided cuts

### Cut 1 — compact the inlined JSON Schema serialization (−7,091 chars, all actions)

`renderAgentResultSchemaHelp` pretty-prints with `JSON.stringify(schema,
null, 2)`: 11,859 chars pretty vs 4,768 compact — **60% of the schema block
is whitespace**. Models don't need the indentation. Same Zod derivation, same
content, so the "inline schema stays honest against the validator" contract
is untouched.

- Change: serialize compact (or `null, 1`) for the prompt inline; keep pretty
  for `agent-result validate --help` if human readability there matters —
  a `format` parameter on the helper, not a second schema source.
- Blast radius: every worker prompt for every action, ~−1.8k tokens each.
- Risk: low. Structural conformance is 100% today with pretty; compact JSON
  is routine model input. Gate with the structural-conformance regression
  assertion (item 3 of the error analysis' eval-case list).

### Cut 2 — split `review-github` into access + resolution (−~2,700 chars for both reviewer templates)

The fragment is two sections with different audiences:

- **GitHub Provider Access** (lines 1–12, 1,250c): `gh` usage, token
  hygiene, pending-review filtering, image-asset handling. Applies to every
  consumer. Keeps rendering everywhere.
- **GitHub Review Rules** (lines 13–36, 3,184c): opens with "For `review`
  and `retry`…" — actionability cutoffs, merge-conflict resolution
  (8 lines), superseded-feedback replies, thread-reply/resolve mechanics.
  The reviewer action is **forbidden** from replying/resolving
  (reviewer.md rule; 0 violations in 112 traces) and never edits code, so
  for reviewer these rules are dead weight that costs tokens on every
  continuation re-grounding.

Change: new fragment `review-github-resolution` holding the Review Rules
section; `review.md`, `review-continuation.md`, `retry.md`, `execution.md`,
`consolidation.md`, `deployment.md` include both fragments (rendered output
byte-identical for them — verify with a render diff). `reviewer.md` and
`reviewer-continuation.md` include access only, plus the three rules from the
resolution section that do bind the reviewer, folded into Reviewer Rules /
the continuation Scope section (~+400c):

- check CI once per pass; never poll or wait for pending checks;
- use historical review context to avoid flip-flopping settled feedback;
- return all GitHub writes as Foreman review mutations.

The e3d7992 invariant holds: both reviewer templates still carry every
fragment the reviewer behavior depends on; the fragment set just got the
review/retry-only content factored out.

### Cut 3 (flagged candidate, needs a design call + eval gate) — per-action mutation variants in the schema

The reviewer schema advertises 6 `reviewMutations` variants (4,265c pretty)
while the template forbids all but `submit_pull_request_review`, and the
corpus contains exactly that one type across all 123 traces. Pruning the
*displayed* schema per action (validator unchanged) would save a further
~1.5k compact chars and stop advertising mutations the prose then has to
forbid. Not decided here: it forks the schema-display from the validator
shape, which weakens the single-source honesty argument in
`worker-result.ts` — worth doing only with an explicit per-action allowlist
in code, not string surgery.

## Keep verbatim (leaking or evidence-strong rules)

- **reviewer.md Reviewer Rules** — the body-vs-thread rule is the one rule
  with observed leaks (3/23 completed reviews put findings in the body).
  Compressing the rule that already leaks is the one move the method forbids.
- **reviewer-audience** — same leak; this fragment is the counterweight.
- **summary-policy** — 243c buys the tightest measured behavior delta in
  either corpus. Now in force in all four review-family templates: review.md,
  reviewer.md, reviewer-continuation.md (fcf26d8), review-continuation.md
  (this audit — see below).
- **worker-common, output-validator** — 100% conformance but they are the
  core contract and jointly cost 8%; not worth the risk per char saved.
- **learning-policy, task-system-linear-worker** — ungraded in this corpus;
  out of scope until a learning-mutation error analysis exists.
- **comment-brevity** — just shipped (PR #129); let traces accumulate before
  touching it.

## Applied with this audit

`review-continuation.md` now includes `{{fragment:summary-policy}}` —
the mirror of fcf26d8, which ENG-5444 scoped to reviewer-continuation only.
The summary-policy corpus shows `review/no_action_needed` is the worst cell
in the entire 296-trace set (12/41 good); the structural cause is identical:
a continuation template with no conciseness contract.

## Benchmark layers gating the cuts

Two layers, because the offline eval (`foreman eval reviewer`) hands the
reviewer a synthetic discovery block and forbids live `gh` — it grades the
*decision* but cannot see the *discovery loop*, which is exactly what the
review-github cut touches.

- **Layer 1 (offline, exists):** `foreman eval reviewer` — 5 cases,
  deterministic graders. Baseline captured at 3 samples × 2 runner families
  (claude/claude-opus-4-8, codex).
- **Layer 2 (live): `invenco/foreman-bench`** — a frozen fixture service
  (parcel-quotes) with open planted-finding PRs the real reviewer action
  reviews end-to-end. Case expectations live in
  `src/eval/cases/foreman-bench-manifest.json` (driver side, never in the
  bench repo — the reviewer explores its worktree, so an in-repo manifest
  would contaminate every case). Fixture PRs stay frozen because the driver
  captures review mutations without applying them. A `live-pr` fixture
  variant in the eval registry is the pending driver work.

## Layer-1 baseline (captured 2026-07-22, current prompt, pre-cut)

`foreman eval reviewer --samples 3`, raw reports committed in
[`baselines/`](baselines/).

| runner / model | pass-rate | stand-down summary chars | completed body chars |
|---|---|---|---|
| claude / claude-opus-4-8 | **15/15, 100% all 6 dimensions** | 96–201 (all 1 sentence) | 61–137, always < largest inline comment (471–581c) |
| codex / gpt-5.5 | **15/15, 100% all 6 dimensions** | 66–123 (all 1 sentence) | 43–72, always < largest inline comment (191–296c) |
| codex / gpt-5.6-sol (default since 2026-07-23) | **15/15, 100% all 6 dimensions** | 62–131 (all 1 sentence) | 63–97, always < largest inline comment (189–259c) |

Two readings matter for the cut gate:

- **The pass-rate is saturated.** Both families sit at 100%, so layer 1 can
  only catch outright regressions, not degradation short of a grader breach.
  Post-cut comparison should therefore also diff the **continuous stats**
  above (summary/body length distributions) — drift toward the ceilings is
  the early-warning signal a saturated pass-rate hides.
- **Saturation is also evidence:** the two failure modes the trace corpus
  surfaced are already fixed at the template level (fcf26d8), and the case
  set derived from them no longer bites. Discriminative power for the cuts
  now rests on the layer-2 planted-PR cases, which exercise the discovery
  loop layer 1 bypasses.

Harness note: the codex baseline initially failed 15/15 with empty output —
`codex exec` refuses to run in an untrusted non-git cwd, and the eval's
synthetic worktree was a bare temp dir. Fixed in `src/eval/run.ts`
(`git init` on the synthetic repo root); live workers were never affected
(real worktrees are git repos).

## Verification plan for cuts 1–2

1. Render before/after prompts for all 12 templates via the eval harness;
   assert byte-identical output for the six non-reviewer consumers of
   `review-github` (cut 2) and content-identical schema JSON (cut 1).
2. Re-run the reviewer eval cases (summary-conciseness grader,
   finding-in-body grader, structural-conformance assertion) against the
   shortened prompts before merging.
3. Post-merge: harvest a fresh trace window and confirm the 23/23 mutation
   conformance and 0-reply invariants held.

## Expected effect

| prompt | today (static chars) | after cuts 1+2 | delta |
|---|---|---|---|
| reviewer first-pass | 28,946 | ~19,100 | −34% |
| reviewer continuation | 23,155 | ~13,300 | −43% |
| every other worker action | — | −7,091 | (cut 1 only) |
