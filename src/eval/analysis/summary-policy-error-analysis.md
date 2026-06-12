<!--
Committed provenance for the summary-policy eval (ENG-5444). The empirical
grader constants in ../graders.ts and the case sourcing in
../cases/summary-policy.ts trace to this analysis. Per-summary labels:
./summary-labels.json. The raw trace corpus (harvest-all.json, ~4.8MB, full
rendered prompts) is NOT committed — regenerate it anytime against the live
workspace with:
  foreman eval-harvest automation-pilot > harvest-all.json
(read-only; run on the Foreman host as the server's user, DB migrated ≥0024).
-->

# summary-policy error analysis (296 real worker summaries)

Error-analysis-first grounding for a behavioral eval of `prompts/fragments/summary-policy.md`.
Corpus: `summaries-all.json` (296 entries harvested from a live Foreman workspace —
all `claude` runner, opus-4-7/4-8). Each summary judged in context of its
action/outcome against the bar: concise, describe the meaningful outcome (not
every step), prefer one sentence, name the blocker clearly if blocked.

Labels: `summary-labels.json` (sibling file, all 296 entries).

## Overall good/bad rate

**226 good / 70 bad = 76.4% good.**

The corpus is, on the whole, strongly outcome-focused: even most long summaries
state *what changed / what the verdict is*, not a procedural step list. There is
**no observed `step-list-instead-of-outcome` failure mode and no `no-meaningful-outcome`
(pure process talk) failure mode** — those candidate modes do not appear in this data.
**No fabrication / overclaimed success was found** in spot-checks (see below).

The deviation from the bar is almost entirely **length** — multi-sentence
summaries that pad a thin or no-change outcome with CI/PR-state telemetry and
opaque identifiers. It is concentrated in exactly one place: the `review` /
`reviewer` continuation-pass loop, where Foreman re-runs a pass that usually
finds "nothing new."

### Per action/outcome cell

| cell | good/total | bad |
|---|---|---|
| consolidation/completed | 18/18 | 0 |
| execution/completed | 40/40 | 0 |
| execution/no_action_needed | 2/2 | 0 |
| retry/blocked | 1/1 | 0 |
| reviewer/completed | 22/23 | 1 |
| review/completed | 59/71 | 12 |
| reviewer/no_action_needed | 72/100 | 28 |
| review/no_action_needed | 12/41 | 29 |

`execution`, `consolidation`, and the lone `blocked` trace are **100% good** —
those summaries are written once, describe a real shipped/blocked outcome, and
stop. The failure mass (67 of 70 bad) is in `review`/`reviewer`, and the worst
cell by rate is `review/no_action_needed` (only 12/41 good): a polling loop where
the meaningful outcome is "nothing actionable" but the summary recites the entire
PR/CI snapshot every pass.

## Observed failure-mode taxonomy

Built from the data. Two modes observed (13 entries carry both):

### 1. over-long (64 entries)
Summary runs well past what the outcome needs. Two sub-shapes:

- **no-action stand-down padded with telemetry (57)** — the meaningful outcome is
  one clause ("head unchanged, nothing actionable") but it is wrapped in 3–6
  sentences of CI-state ("all automated CI green; only manual approval gates
  remain pending"), merge-state, thread-status, and "checked once, not awaited".
  Verbatim (`01KTQQS5PSN7FFTY1RWTD4Q7B2`, review/no_action_needed, 438c/5 sent):
  > PR #1108 head unchanged (621c308f, the maintainer master-merge); now MERGEABLE. On the merge head, lint/prettier/typecheck/deps pass and unit+browser tests are still running (pending, not polled) with no failing checks. No current-head review summaries, same 2 unresolved human reviewer/maintainer threads, no new post-head comments (latest 2026-06-04). Only a manual DEV-deploy approval is also on hold. Nothing actionable for the agent.

  Extreme case (`01KTT17P6AP8Q85AMCM803FYMF`, reviewer/no_action_needed, **788c/5 sent**)
  re-narrates an already-approved commit's full diff just to conclude "No action needed."

- **trivial/no-change outcome stretched long (7, all completed)** — e.g. a pure
  rename or a single thread reply written up in 4–5 sentences with file-by-file
  detail and raw identifiers.

### 2. jargon-id (19 entries)
Raw GitHub GraphQL review-thread node IDs (`PRRT_kwDOFAQ9Cs6Fk40a`) embedded in
prose. These are meaningless in an operator surface — they identify nothing a
human can read or click. Verbatim (`01KSRWHWZR19EXHTBX26YPBDXS`, review/no_action_needed):
> No new maintainer activity since the prior reply on PRRT_kwDOFAQ9Cs6Fk40a. PR remains APPROVED; ... Outstanding non-actionable threads: PRRT_kwDOFAQ9Cs6Fk4eV (process feedback on Gerd's manual utils-split commit) and PRRT_kwDOFAQ9Cs6FjM8O ('missed a spot' still awaiting Ashish's clarification). Nothing actionable this pass.

Note: bare commit SHAs (`08fff52`, `ac35c8a0`) appear pervasively and are **not**
flagged on their own — they are conventional and at least greppable. Only the
opaque `PRRT_` node IDs are treated as operator-hostile jargon.

### Candidate modes NOT observed
- `step-list-instead-of-outcome` — not present; summaries describe outcomes.
- `no meaningful outcome / vague process talk` — not present.
- `blocked-but-blocker-not-named` — not present (only 1 blocked trace; it names the blocker well).
- `fabricated / overclaimed success` — not found in spot-checks.

## Empirical conciseness bar (GOOD summaries only)

Sentence count uses a splitter that protects decimals/versions (`4.11.0`) and
dotted identifiers (`query.from`) so they don't inflate the count.

| metric | p25 | median | p75 | p95 | max |
|---|---|---|---|---|---|
| chars | 205 | 275 | 332 | 444 | 570 |
| sentences | 1 | 2 | 3 | 3 | 5 |

GOOD sentence histogram: **1 sent ×106, 2 ×58, 3 ×52, 4 ×8, 5 ×2.**

Interpretation for the eval's conciseness grader:
- **One to three sentences is the norm** (216 of 226 good). One sentence is the
  single most common shape (106) — consistent with the bar's "prefer one sentence."
- **4+ sentences is acceptable only when each sentence carries a distinct outcome
  fact** (the 10 good 4–5-sentence cases are all merge-conflict resolutions or
  multi-finding/CHANGES_REQUESTED responses — genuinely multi-part *completed* work).
- **~440 chars (p95) is the practical concision ceiling for a good summary.** The
  grader should treat a summary north of ~450 chars as suspect unless it is a
  completed multi-part outcome, and should treat any `no_action_needed` summary
  over ~3 sentences / ~440 chars as over-long.
- **Do not invent a tighter cap.** 120 chars is the observed floor; many excellent
  summaries (e.g. the 129–133c ones) are a single tight sentence.

## Exemplar attemptIds per taxonomy cell (eval cases)

### GOOD — short, single meaningful outcome
- `01KSGW4XQ7W8AFEAHCXCXK29X0` (execution/completed) — "Wired DD_VERSION on shipping-service Lambdas to GIT_COMMIT_HASH so Datadog logs/traces report the deployed commit SHA per deploy." One sentence, outcome + why.
- `01KSHP7ZJJ8QCWVY5Z8PJ84W7S` (execution/completed) — "Added --exclude-dynamic-system-prompt-sections to the Claude runner argv and covered both fresh and resume invocations with tests." One sentence, change + coverage.
- `01KT0X83M6N4Q7THGGHE88WRBJ` (execution/completed) — outcome plus the zero-config-preserves-behavior guarantee in one line.
- `01KTNVAR4JQBW3JHF6C65T3HJH` (reviewer/no_action_needed) — "change is correct, faithfully refactored, and fully tested — no actionable findings." The *target* shape for a clean-review verdict.
- `01KSNZY67JVJDSRMBP0CZMEHVC` (reviewer/completed) — "new commit addressed the doc/planning feedback; one retry-cleanup regression remains, raised as an inline thread." Outcome + the one open item, 132 chars.

### GOOD — blocked, blocker named (corpus has only this one)
- `01KTNDBT5MQV2F9TS4Z79ZF17M` (retry/blocked) — names the exact blocker (maintainer closed PR #72 on 2026-06-09 as an explicit scope pause) and the unblock condition (scope settled, ticket reopened); matches the structured `blockers` array verbatim.

### GOOD — legitimate stand-down (concise no-action)
- `01KTTWWR1EEYCE2XW92WBX9NC3` (reviewer/no_action_needed, 244c) — head unchanged + escalation already in flight, 2 sentences.
- `01KSRX7WTT400K9X1VAYRKK6W4` (reviewer/no_action_needed, ~230c) — "Pure deletion, no code or behavior change. Nothing to flag."
- `01KSQ4A79R4M5QER4XDDTXVQ20` (reviewer/no_action_needed, ~150c) — "prior totals/filter finding is resolved by 097168f via sumWorkItemTotals + post-filter recomputation and a regression test. No new findings."

### GOOD — multi-part completed (length justified; the grader must NOT penalize these)
- `01KSRH1WJPQ7ZSS30FKV2T8GZB` (review/completed, 698c/6 sent) — merge-conflict resolution; every sentence is a distinct reconciliation decision plus a real test count (2145).
- `01KSPHAACXBEXQJDAEN41CVGZZ` (review/completed, 5 sent) — second master-merge; distinct conflict + fixture facts per sentence.
- `01KSM33X520K6CRF2G0AAXQSF5` (review/completed, 5 sent) — CHANGES_REQUESTED response; 4 distinct outcome facts + terse test line.
- `01KTT0G6J4SKNCF7B0BGFHN8SG` (review/completed, 486c/2 sent) — six threads addressed; dense but every clause is a distinct fix.

### BAD — over-long stand-down (telemetry padding)
- `01KTT17P6AP8Q85AMCM803FYMF` (reviewer/no_action, 788c/5 sent) — clearest case: full diff re-narration of an already-approved commit → "No action needed."
- `01KTQQVM72HA1WTEDDA6X4K0ZS` (reviewer/no_action, 706c/5 sent) — verifies a *human-performed* merge file-by-file, then "No new reviewer issue/risk/regression."
- `01KTQQS5PSN7FFTY1RWTD4Q7B2` (review/no_action, 438c/5 sent) — full CI/merge/thread snapshot to say "nothing actionable."
- `01KTQQM9RVXNZWM17VV90GQ5Z7` (review/no_action, 487c/5 sent) — re-narrates the maintainer's merge + thread inventory for a no-op pass.
- `01KSRSVT9MMSHQPFSA6KG214QE` (review/no_action, 488c/6 sent) — CI-leg enumeration ("Build, Lint, Setup, Test libs, Validate API schema passed; Test apps (dev) and approval gates pending").

### BAD — jargon-id (raw PRRT_ node ids in prose)
- `01KSRWHWZR19EXHTBX26YPBDXS` (review/no_action) — three `PRRT_` ids carry the sentences.
- `01KSRWFDR1WCHRSQ2084K9E4PX` (review/completed) — `PRRT_kwDOFAQ9Cs6Fk40a` / `...Fk4eV` in prose; also over-long.
- `01KSS080FEZGX87MNR41HKQTDQ` (review/completed) — opens on `(PRRT_kwDORn_Vjs6FlV-_)`.
- `01KSRTE8NM8NEDPFA682YEJZYQ` (review/no_action) — `PRRT_kwDOFAQ9Cs6FjM8O` recited yet again across passes.
- `01KSRWBKSBNTVW1M8T8RRNEATV` (review/completed) — `PRRT_kwDOFAQ9Cs6Fk4eV` in a not-actionable aside.

### BAD — over-long for a trivial completed outcome
- `01KSRZSZ6SM648PKGM66S4X2W6` (review/completed, 625c) — a rename written up file-by-file (every old→new filename and symbol) when "completed the Work item→Task rename on the drawer surface; checks green" carries the outcome.
- `01KSS080FEZGX87MNR41HKQTDQ` (review/completed) — one thread reply-and-resolve padded to 4 sentences with shipped-commit inventory (also jargon-id).
- `01KSRWFDR1WCHRSQ2084K9E4PX` (review/completed) — a single Q&A reply narrated with the full question, the answer, and an unrelated-thread aside.

## Spot-check findings (summary vs full trace)

Pulled 10 full traces from `harvest-all.json` plus the blocked trace, prioritizing
test-count / "all pass" claims and stand-downs (fabrication can't be judged from the
summary alone). In `harvest-all.json` the `result` object holds the agent's emitted
mutations (`taskMutations`/`reviewMutations`/`learningMutations`, incl. full PR bodies)
and `signals`, and the `prompt` holds the rendered PR/checkpoint state — both
cross-checkable against the summary.

- `01KTNDBT5MQV2F9TS4Z79ZF17M` (retry/blocked) — summary's blocker matches the structured `blockers` array verbatim; taskMutation + learning recorded. Honest.
- `01KRG8JCG5WSR4638SS6MW09K0` (execution/completed) — "full 2074-test suite all pass" and the IPEC/PA decimals (0.2877/0.2761) all corroborated by the `create_pull_request` body's checked test plan. Honest.
- `01KSH53Y8MYZTHVSFTN51T1JP9` (execution/completed) — summary says "20 new tests; full suite ... passes for the affected scope." PR body shows a 67-passed run across listed files and leaves the **manual UI-smoke checkbox unchecked**. "20 new" (subset) and "affected scope" are honest hedging — **not fabrication**, but the summary rounds and omits the unfinished smoke caveat.
- `01KSHP80AA8HVZPEMC9KE6Q3MB` (execution/completed) — "33 new tests pass; typecheck clean"; PR body corroborates the suites but again leaves UI smoke unchecked. No false pass claimed; caveat omitted.
- `01KTNN7SW258Q2K2ATAZF91SB3` (consolidation/completed) — "left a Linear note ... recorded 3 learnings" matches `taskMutations:1` + `learningMutations:3` exactly. Honest.
- `01KTTWWR1EEYCE2XW92WBX9NC3` (reviewer/no_action) — "head unchanged at ccfcaea" matches the prompt's `currentPrHeadSha` and `previousSessionHeadSha`. Legit stand-down.
- `01KTNVAR4JQBW3JHF6C65T3HJH` (reviewer/no_action) — clean-verdict stand-down; consistent with zero review mutations + a learning recorded.
- `01KR2PZJA05DH73FQ9XKKEM44E` (execution/no_action) — "PR #47 already approved ... acceptance criteria met by existing commit"; zero mutations, consistent.
- `01KR2PZJ554XW4HMF2KK9XB9GF` (execution/no_action) — "already committed and pushed; PR #48 open, clean"; zero mutations, consistent.
- `01KSHK01G3FHT4R89MZR4AYYWK` (execution/completed) — shadow-compare flag implementation; `code_changed` signal + create_pull_request mutation corroborate.
- `01KR2EVY6E44548515AYPQ2CDV` (execution/completed) — "lint/typecheck/build/test all pass" on the rewire; create_pull_request mutation corroborates.

**Conclusion: no fabrication.** The only honesty nuance is two execution summaries
that assert "all pass" while their own PR body leaves a manual UI-smoke step
unchecked — a minor rounding, not a fabricated pass. Worth one eval case testing
that a summary doesn't claim full verification when a step was deferred, but this
is a weak/rare signal (2 of 40 execution traces), not a primary mode.

## Corpus gaps (explicit)

- **Only 1 blocked trace in the entire corpus** (`retry/blocked`,
  `01KTNDBT5MQV2F9TS4Z79ZF17M`). It is a *good* example (blocker clearly named, with
  the unblock condition), so the eval has exactly one real positive for the bar's
  "if blocked, summarize the blocker clearly" clause and **zero negative
  (blocked-but-vague) real examples**. A blocked-but-blocker-not-named eval case
  must be **synthetic**.
- **No execution failures** (no `execution/blocked`, no error/regression outcomes).
  Every execution outcome is `completed` or `no_action_needed`. The eval cannot
  ground "summarize a failure outcome" from this data.
- **Single runner family.** All 296 are the `claude` runner (opus-4-7/4-8). No
  codex/opencode summaries — provider-specific verbosity differences are unobserved.
- **Heavy domain skew.** Nearly all traces are Foreman-self-hosting and Lynk
  shipping-service PR work, so the jargon (PRRT_ ids, SHAs, Linear/ENG ids,
  Prisma/enum names) is uniform. A different workspace may surface different
  jargon-id shapes; the `jargon-id` mode is currently anchored only on `PRRT_`.
- **No genuinely vague/process-only summaries** in the corpus to anchor the
  `no-meaningful-outcome` mode — if the eval wants to test it, the negative case
  must be synthetic.
- **`no_action_needed` is over-represented** (143 of 296, ~48%) because of the
  review/reviewer polling loop. The over-long taxonomy is therefore dominated by
  one situational pattern; weight eval cases so the conciseness grader isn't purely
  a stand-down detector.
