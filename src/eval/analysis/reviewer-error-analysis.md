<!--
Error-analysis-first grounding for a behavioral eval of the reviewer-action
worker (prompts/templates/reviewer.md + reviewer-continuation.md). Per-trace
labels: ./reviewer-labels.json. Corpus: ./reviewer-worksheet.json (123 traces,
distilled) + ./harvest-reviewer.json (full rendered prompts, 1.8MB, read by
attemptId with jq — never whole). Regenerate the harvest against the live
workspace with `foreman eval-harvest automation-pilot` (read-only). This mirrors
the committed summary-policy analysis (src/eval/analysis/summary-policy-error-analysis.md).
-->

# reviewer-action error analysis (123 real reviewer worker traces)

Error-analysis-first grounding for a behavioral eval of Foreman's **reviewer**
action — the first-pass / continuation review worker that scans one selected PR
and leaves inline-thread feedback or stands down.

Corpus: `reviewer-worksheet.json` (123 traces harvested from the live
`automation-pilot` workspace — all `claude` runner, opus-4-7 ×90 / opus-4-8 ×33).
Each trace judged against **the template rules in force for its `promptVariant`**:

- `first_pass` (38 traces) → current `reviewer.md` (Reviewer Rules + reviewer-audience + summary-policy + learning-policy).
- `continuation` (74 traces) → `reviewer-continuation.md` (review-github + reviewer-audience only; **no summary-policy, no learning-policy fragment**).
- `legacy` (11 traces) → a pre-template ~1260-char prompt ("Review the latest PR changes…") with **no** body-vs-thread, summary-conciseness, or inline-comment rules. Marked `era: "legacy"` and excluded from threshold derivation.

Labels: `reviewer-labels.json` (sibling, all 123 traces).

## Overall good/bad rate

**91 good / 32 bad = 74.0% good.**

| variant | good/total | bad | era |
|---|---|---|---|
| first_pass | 35/38 | 3 | current |
| continuation | 50/74 | 24 | current |
| legacy | 6/11 | 5 | legacy (excluded from bars) |

The failure mass is **entirely in two narrow modes**, both about *the prose
container around the review*, never the review judgement:

1. The continuation **no-action stand-down summary** is bloated (24 of 24 bad continuation traces). The root cause is a **template gap**: `reviewer-continuation.md` does not include `{{fragment:summary-policy}}`, so the continuation pass has no conciseness contract at all.
2. Three first-pass **completed** reviews put the full actionable finding in the top-level body, duplicating the inline thread — the one behavior `reviewer.md` explicitly forbids.

**No verdict error was found** (every `no_action_needed` is internally
consistent with the PR state it describes; no swallowed finding). **No
mutation/outcome inconsistency exists** (zero `completed`-without-mutation, zero
`no_action`-with-mutation). **No reply-to-existing-thread violation exists.**
Signals are not a behavioral contract and are not graded (see §Signals).

## What was graded, and how

| dimension | rule source | result |
|---|---|---|
| (a) verdict right for context | worker-common ("nothing to do → no_action") | **0 wrong.** Spot-checked stand-downs against rendered prompt PR state (head SHA, draft flag, described change). All hedge-word summaries resolve the concern they name. Full code re-review out of scope — graded for internal consistency only. |
| (b) review-mutation conformance | reviewer.md Reviewer Rules + reviewer-audience | **`event:"COMMENT"` 23/23.** All 23 completed traces emit exactly one `submit_pull_request_review`, all `COMMENT`, all with ≥1 inline comment. Findings-in-thread holds for 20/23; 3 leak findings into the body (see Mode 2). |
| (c) no replies to existing threads | reviewer.md ("Do not reply to existing review threads…") | **0 violations.** No trace emits `reply_to_thread_comment` / `reply_to_pr_comment`; the only mutation type present is `submit_pull_request_review`. |
| (d) summary conformance | summary-policy fragment | **29 over-long** (= the reviewer-corpus ∩ summary-policy `over-long` set, exactly). first_pass summaries are tight (max 363c); the over-long mass is continuation + legacy. |
| (e) signals correctness | — | **Not graded.** No template requests signal emission; values are schema-era / harness dependent and non-deterministic (see §Signals). |

## Observed failure-mode taxonomy

Built from the data. Two modes; no trace carries both (they live in disjoint
variant/outcome cells).

### 1. summary-overlong (29 traces — 24 continuation, 5 legacy)

A `no_action_needed` (or completed) stand-down whose `summary` field re-narrates
the entire diff / CI / thread snapshot instead of stating the one-clause outcome.
This is the **same population and the same per-summary verdicts** as the
committed summary-policy analysis — all 29 are labeled `over-long` there, an
independent 29/29 agreement.

The driver is structural, not stochastic: **`reviewer-continuation.md` omits the
summary-policy fragment**, and 74 of 123 traces are continuations. With no
conciseness contract, the continuation pass writes a forensic re-verification of
the maintainer's last commit before concluding "nothing actionable."

Exemplars (all continuation `no_action`):
- `01KTT17P6AP8Q85AMCM803FYMF` — **788c**, the clearest case: full diff re-narration of an already-APPROVED commit, ending "No action needed."
- `01KTQQVM72HA1WTEDDA6X4K0ZS` — **706c**: verifies a *human-performed* master-merge file-by-file for a no-op pass.
- `01KT8YTC0DP10J17GWQESCDS14` (685c), `01KTNGEWSD7SMJ6YFB3J4XMEJS` (677c), `01KSPFRF69HPQC99JKY3T138NB` (566c) — same shape.

Legacy exemplars (graded era=legacy, summary field still operator-facing):
- `01KR0TFCSPHKY18X2C5G4GAHJC` (617c), `01KR2PBPXPE5ZY5K4W91RXFRFJ` (477c).

### 2. finding-in-body (3 traces — all first_pass, completed)

The top-level review **body** spells out the actionable finding (location +
consequence + fix) that is *also* in an inline thread — duplicating the resolver
work unit and violating reviewer.md: *"Keep the top-level summary short: one
paragraph stating overall stance and the thread count. Do not put actionable
findings in the summary."* The reviewer-audience fragment reinforces it:
findings "get missed or duplicated when the resolver iterates threads."

The signature is length: good completed bodies cap at **682c** (p95 621); these
three are **1038–1387c**, all >1.5× the ceiling.

- `01KRJ8Q45N0RFQ606WR0ZNFF56` (1387c, 3 threads) — body enumerates two numbered findings + a "Minor:" item, each with the fix.
- `01KRG9P5WFAN8CN6X01CHP987V` (1038c, 2 threads) — both findings restated as bullets with file + reasoning.
- `01KR0SMX2NMQTPB9EA22PRPP79` (1345c, 1 thread) — the tsconfig-divergence finding fully resolved in the body; the single thread is now redundant.

Note: the legacy completed `01KR2B5TRSAQ1Z5JE8T33GESW8` (2563c body, findings in
body) is **NOT** counted here — its prompt had no body-vs-thread rule. It is
era=legacy and carries only `summary-overlong`.

### Candidate modes NOT observed (findings)

- **wrong verdict / missed finding** — **none.** Every `no_action_needed` is consistent with the PR state described; every summary that names a concern resolves it (deferral acknowledged, addressed in commit X, documented in PR description, intentional + tested). The corpus has **zero** "named a problem then declined to raise it" cases. *(Caveat: graded on internal consistency, not independent re-review — see Corpus gaps.)*
- **reply-to-existing-thread from reviewer** — **none.** The reviewer action never emitted a reply/resolve mutation; the only mutation type in the entire corpus is `submit_pull_request_review`.
- **wrong review `event`** — **none.** 23/23 completed are `event:"COMMENT"`; no `APPROVE` / `REQUEST_CHANGES` leaked in.
- **mutation/outcome inconsistency** — **none.** No `completed` lacks a mutation; no `no_action_needed` carries one.
- **findings in body instead of threads on continuation traces** — **none.** All 5 continuation completed traces keep findings in threads; the body-leak mode is first_pass-only.
- **fabricated test/CI claims** — not separately re-derived here; the summary-policy spot-check over the overlapping corpus found no fabrication. Not re-flagged.

## Empirical bars (provenance-tagged)

### Completed-review body length — GOOD only, non-legacy, finding-in-body excluded (n=19)

| metric | min | p25 | p50 | p75 | p90 | p95 | max |
|---|---|---|---|---|---|---|---|
| body chars | 149 | 207 | 449 | 538 | 621 | 621 | **682** |

Provenance: the 22 non-legacy completed traces minus the 3 `finding-in-body`
bad ones. **The good body ceiling is ~680c.** The 3 bad bodies (1038, 1345,
1387c) sit cleanly above it — a body north of ~900c is the empirical
finding-in-body tripwire.

### Inline-thread comment body length — GOOD completed, same 19 traces (n=30 comments)

| metric | min | p25 | p50 | p75 | p95 | max |
|---|---|---|---|---|---|---|
| comment chars | 498 | 715 | **962** | 1150 | 1551 | 1676 |

Provenance: every inline comment across the 19 good completed traces. **The
inline thread is where the weight lives (median ~960c); the top-level body
(median 449c) is the lighter container.** A good review inverts the bad pattern:
body < thread. The 3 finding-in-body bads invert *that* — body ≥ thread.

### Inline-comment count per completed review — GOOD set (n=19)

`1 ×11, 2 ×6, 3 ×1, 4 ×1.` Median 1, max 4. Provenance: same 19 traces.
Most reviews raise a single sharp thread; "prefer fewer, sharper threads"
(reviewer-audience) holds — no shallow-thread spam observed.

### no_action summary length — by variant (provenance for the summary grader)

| subset | n | p25 | p50 | p75 | p95 | max |
|---|---|---|---|---|---|---|
| first_pass no_action (summary-policy **in force**) | 21 | 177 | 196 | 230 | 316 | **363** |
| continuation no_action (summary-policy **absent**) | 69 | 267 | 328 | 411 | 566 | **788** |

Provenance: `reviewer-worksheet.json`, `summary` char length, split by variant.
**This table is the headline finding.** With the policy present (first_pass), the
stand-down summary maxes at 363c. With it absent (continuation), the *median*
(328c) is already ~= the first_pass *max*, p95 hits 566c, and the tail reaches
788c. The summary-policy ceiling (~440c for a no_action stand-down, from the
committed analysis) cleanly separates the populations: **0 first_pass breaches,
16 continuation breaches >500c, 24 continuation total flagged.**

## Signals — not a behavioral contract (investigated, then de-scoped)

The known-facts called out two signal anomalies. Both resolve to harness/schema
era, not model behavior, so **signals are excluded from grading**:

- **The "typo" signal `review_checkpoint_eligible`** (1 trace, `01KT0YP8SVS8HZEXGEATXT9CZV`, 2026-06-01). No template instructs signal emission. That trace's rendered prompt had **no result-schema and no signals enum at all** (early-era empty `{{context:result-schema}}`), so the model free-formed the value. Separately, **22 later prompts (2026-06-03→06-11) carried a schema enum that listed BOTH `review_checkpoint_eligible` and `reviewer_checkpoint_eligible` as valid** — i.e. the typo spelling was, for an era, schema-blessed. Either way it is a schema-era artifact, not a behavioral defect.
- **25 traces emit no signal.** All 25 have prompts whose schema offered **no** `reviewer_checkpoint_eligible` enum value (early era). The cross-tab: `enum-absent → 25 no-signal / 76 signal`, `enum-present → 4 no-signal / 18 signal`. Signal emission does not track the prompt the model was given — it is non-deterministic and harness/era-coupled. The templates never request it. Counts: 94 traces emit `reviewer_checkpoint_eligible`, 1 emits the typo, 28 emit nothing.

Conclusion: **do not write a signals grader.** Signals are infrastructure
telemetry, orthogonal to the reviewer's behavioral job.

## Corpus gaps (explicit — synthetic eval cases will be flagged against this list)

- **Verdict correctness is under-tested by construction.** The rendered prompt
  carries PR *metadata* (head SHA, draft flag, merge state) but not the inline
  diff — the worker fetches it via `gh`. So a `no_action_needed` verdict can be
  graded for *internal consistency* but **not independently re-derived**. Zero
  observed missed-findings is therefore a *consistency* result, not a proof of
  zero false-negatives. A "should-have-raised-a-finding" eval case must be
  **SYNTHETIC** (hand a prompt with a planted bug, assert a thread is raised).
- **Outcome skew: 100 `no_action_needed` / 23 `completed`, zero `blocked`, zero
  `failed`.** The reviewer almost never blocks. Any blocked-reviewer eval case is
  **SYNTHETIC** — no real positive or negative exists.
- **Single runner family.** All 123 are `claude` (opus-4-7 / 4-8). No
  codex/opencode reviewer traces — provider-specific body/summary verbosity is
  unobserved.
- **Continuation-heavy (74/123, 60%).** The taxonomy is dominated by the
  continuation stand-down loop; weight eval cases so the summary grader isn't
  purely a continuation-stand-down detector.
- **Heavy domain skew.** Nearly all PRs are Foreman-self-hosting + Lynk
  shipping-service work; jargon (SHAs, ENG-ids, Prisma names) is uniform. The
  `PRRT_` operator-hostile-jargon mode that summary-policy found does **not**
  intersect this reviewer subset (0 reviewer traces carry it) — a jargon-id
  reviewer eval case would be **SYNTHETIC** here.
- **Multi-thread reviews are thin.** Only 2 of 19 good completed reviews raise
  ≥3 threads. The "many shallow threads" anti-pattern from reviewer-audience has
  **no real positive example** — testing thread-count discipline needs a
  SYNTHETIC over-threaded case.
- **`finding-in-body` has only 3 real exemplars**, all first_pass, all
  ≥1038c. Enough to anchor a grader bar but a thin positive class — pair with
  the 19 good-body negatives.

## Implications for eval-case design

Which observed modes deserve cases/graders, ranked by real-data support:

1. **summary-overlong on the continuation pass (PRIMARY, 24 real bads).**
   Strongest signal, structural root cause. Two complementary actions:
   - **Fix the template** — add `{{fragment:summary-policy}}` to
     `reviewer-continuation.md` (it is the only reviewer template missing it).
     This is the highest-leverage change the analysis surfaces.
   - **Grader** — a conciseness grader on the `summary` field for
     `no_action_needed`: flag >~440c / >3 sentences for a stand-down. Seed cases
     from the 24 continuation bads (negatives) and the tight first_pass
     stand-downs `01KR2BNEAERSK2DZCD13X2BNTA` (138c), `01KTNVAR4JQBW3JHF6C65T3HJH`
     (159c), `01KSHV9PWBXPY0AV2HDCMBV3CP` (176c) as positives.

2. **finding-in-body on completed reviews (SECONDARY, 3 real bads).**
   Grader: for a `completed` review, the top-level `body` must not contain the
   actionable finding detail that belongs in threads. Empirical tripwire: body
   >~900c, or body length ≥ its largest inline comment. Negatives:
   `01KRJ8Q45N0RFQ606WR0ZNFF56`, `01KRG9P5WFAN8CN6X01CHP987V`,
   `01KR0SMX2NMQTPB9EA22PRPP79`. Positives (good body < thread): the 19-trace
   good set, anchored by `01KTNWTMT60Q8Q4GZD0EMEB0XC` (582c body / 2 threads),
   `01KSH6BY13CWW5WKE0E0ZEP6V1` (327c body / 4 threads), `01KSHMTK8T9E230GGA7YPJQGWP`
   (207c body / 1 thread).

3. **review-mutation structural conformance (REGRESSION GUARD, 23 positives).**
   `event:"COMMENT"`, exactly one `submit_pull_request_review`, ≥1 inline comment
   when completed, no reply/resolve mutation. 100% clean today — encode as an
   always-pass conformance assertion so a future regression is caught.

4. **wrong-verdict / missed-finding (SYNTHETIC only).** Zero real exemplars and
   un-re-derivable from the harvest. If wanted, plant a bug in a synthetic PR
   context and assert the reviewer raises a thread rather than standing down.
   Flag **SYNTHETIC**.

5. **Do NOT build:** a signals grader (era artifact, de-scoped above); a
   jargon-id grader for the reviewer subset (0 real exemplars — that mode lives
   in the broader summary corpus, not here).
