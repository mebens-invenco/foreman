import { z } from "zod";

import type { WorkerResult } from "../domain/index.js";
import type { LearningExpect } from "./cases/learning-policy.js";
import type { SummaryExpect } from "./cases/summary-policy.js";
import type { EvalCase, Grader, GraderResult } from "./types.js";

/**
 * Narrows a case to its completed-session fixture and returns the session text.
 * The learning-policy and summary-policy judges feed this synthetic session to
 * the judge as ground truth; those evals only ever carry completed-session
 * fixtures, so a wrong fixture type is a construction error — throwing here
 * matches the repo's test-narrowing style (a misconfigured registry fails loud,
 * not silently). The pr-review fixture has no single "session" to judge against.
 */
const completedSession = (evalCase: EvalCase): string => {
  if (evalCase.fixture.type !== "completed-session") {
    throw new Error(`judge grader requires a completed-session fixture, got "${evalCase.fixture.type}"`);
  }
  return evalCase.fixture.session;
};

/**
 * Graders for the learning-policy write-back.
 *
 * The worker-result Zod schema (worker-result.ts) is intentionally loose — it
 * accepts empty `tags` and unstructured `content` — so the quality of a
 * learning is NOT enforced there. These graders close that gap: the
 * deterministic ones check the structure/taxonomy the schema lets through, and
 * the judge scores the dimensions structure can't see (is it actually a
 * reusable rule, or just a restatement of the task?).
 */

// Action tags defined by prompts/fragments/learning-policy.md. A learning must
// carry exactly one, identifying the action that surfaced it.
const ACTION_TAGS = ["execution", "consolidation", "review", "reviewer", "retry", "deployment"] as const;

// Required content markers from the learning-policy "Structure the content" block.
const REQUIRED_CONTENT_MARKERS = ["**Rule:**", "**When to apply:**"] as const;

type LearningAdd = Extract<WorkerResult["learningMutations"][number], { type: "add" }>;

const learningAdds = (result: WorkerResult): LearningAdd[] =>
  result.learningMutations.filter((mutation): mutation is LearningAdd => mutation.type === "add");

const pass = (dimension: string, detail: string): GraderResult => ({ dimension, pass: true, detail });
const fail = (dimension: string, detail: string): GraderResult => ({ dimension, pass: false, detail });

/**
 * Parsed + validated against the action-specific worker-result schema. Reads no
 * `expect`, so it is prompt-agnostic: a factory generic over `Expect` lets every
 * prompt's grader array hold a correctly-typed instance (rather than each prompt
 * re-implementing the same parse check).
 */
export const makeSchemaGrader = <Expect>(): Grader<Expect> => ({
  name: "schema",
  grade: ({ result, parseError }) =>
    result
      ? pass("schema", "parsed and validated against the worker-result schema")
      : fail("schema", `did not parse/validate: ${parseError ?? "unknown error"}`),
});

/** Learning-policy's schema grader instance. */
export const schemaGrader: Grader<LearningExpect> = makeSchemaGrader<LearningExpect>();

/** The learning-review decision matches what the case expects. */
export const emitsExpectedGrader: Grader<LearningExpect> = {
  name: "emits-expected",
  grade: ({ evalCase, result }) => {
    if (!result) {
      return fail("emits-expected", "no parseable result to inspect");
    }
    const count = result.learningMutations.length;
    if (evalCase.expect.decision === "learning") {
      return count > 0
        ? pass("emits-expected", "emitted a learning as expected")
        : fail("emits-expected", "expected a learning but learningMutations was empty");
    }
    return count === 0
      ? pass("emits-expected", "correctly emitted no learning")
      : fail("emits-expected", `expected no learning but emitted ${count}`);
  },
};

/** Every added learning carries exactly one action tag, matching the run action. */
export const tagsGrader: Grader<LearningExpect> = {
  name: "tags",
  grade: ({ evalCase, result }) => {
    if (!result) {
      return fail("tags", "no parseable result to inspect");
    }
    const adds = learningAdds(result);
    if (adds.length === 0) {
      return pass("tags", "n/a (no add mutations)");
    }
    for (const add of adds) {
      if (add.tags.length === 0) {
        return fail("tags", `learning "${add.title}" has empty tags`);
      }
      // Contract per output-validator.md ("at least one action-type tag") and
      // learning-policy.md ("the action that surfaced it"): the tags must carry
      // at least one action tag, and the surfacing run action must be among
      // them. Extra action-name tags used as topics are tolerated here.
      const actionTags = add.tags.filter((tag) => (ACTION_TAGS as readonly string[]).includes(tag));
      if (actionTags.length === 0) {
        return fail("tags", `learning "${add.title}" carries no action tag (need at least one of ${ACTION_TAGS.join("|")})`);
      }
      if (!actionTags.includes(evalCase.action)) {
        return fail("tags", `learning "${add.title}" must tag the surfacing action "${evalCase.action}"; found action tag(s) [${actionTags.join(", ")}]`);
      }
    }
    return pass("tags", `all ${adds.length} learning(s) tag the surfacing action "${evalCase.action}"`);
  },
};

/** Every added learning uses the required Rule / When-to-apply content structure. */
export const structureGrader: Grader<LearningExpect> = {
  name: "structure",
  grade: ({ result }) => {
    if (!result) {
      return fail("structure", "no parseable result to inspect");
    }
    const adds = learningAdds(result);
    if (adds.length === 0) {
      return pass("structure", "n/a (no add mutations)");
    }
    for (const add of adds) {
      const missing = REQUIRED_CONTENT_MARKERS.filter((marker) => !add.content.includes(marker));
      if (missing.length > 0) {
        return fail("structure", `learning "${add.title}" content missing required marker(s): ${missing.join(", ")}`);
      }
    }
    return pass("structure", `all ${adds.length} learning(s) include Rule + When-to-apply structure`);
  },
};

/**
 * Emitted learnings match the case's expected repo scope. ADVISORY: reported but
 * does not gate a sample's pass — scope is a softer judgment than the structural
 * checks, and the policy itself leaves room ("use `shared` only when the insight
 * is clearly cross-repo"). Checks the `repo` field the worker-result schema lets
 * through unverified: "shared" must be the literal shared scope; "repo-specific"
 * must be any non-shared repo.
 */
export const scopeGrader: Grader<LearningExpect> = {
  name: "scope",
  advisory: true,
  grade: ({ evalCase, result }) => {
    const expectScope = evalCase.expect.scope;
    if (!expectScope) {
      return pass("scope", "n/a (no scope expectation)");
    }
    if (!result) {
      return fail("scope", "no parseable result to inspect");
    }
    const adds = learningAdds(result);
    if (adds.length === 0) {
      return pass("scope", "n/a (no add mutations)");
    }
    for (const add of adds) {
      const isShared = add.repo === "shared";
      if (expectScope === "shared" && !isShared) {
        return fail("scope", `expected a shared (cross-repo) learning but "${add.title}" is scoped to repo "${add.repo}"`);
      }
      if (expectScope === "repo-specific" && isShared) {
        return fail("scope", `expected a repo-specific learning but "${add.title}" used the "shared" scope`);
      }
    }
    return pass("scope", `all ${adds.length} learning(s) match the expected ${expectScope} scope`);
  },
};

// Binary verdict, not a 1-5 Likert: per current eval practice (Hamel/Shreya),
// binary judgments label more consistently across runs than Likert points whose
// boundaries drift between annotators and samples. The judge is also ADVISORY
// until calibrated against human labels (TPR/TNR) — see judgeGrader.advisory —
// so it never fails a sample on its own.
const judgeVerdictSchema = z.object({
  verdict: z.enum(["yes", "no"]),
  rationale: z.string().min(1),
});

// Shared <judge>…</judge> extraction for all LLM-as-judge graders: pull the last
// well-formed judge block from the model stdout (or fall back to the whole
// output) and validate it against that judge's verdict schema.
//
// The scan mirrors parseWorkerResult (ENG-5450). A judge verdict is model output
// that can echo the literal <judge> delimiter — e.g. a rationale quoting the tag
// it was told to emit — so a naive lastIndexOf(open) latches onto the in-payload
// mention, slices a truncated fragment, and drops an otherwise valid verdict.
const parseJudgeBlock = <Schema extends z.ZodType>(stdout: string, schema: Schema): z.infer<Schema> | null => {
  const open = "<judge>";
  const close = "</judge>";
  const trimmed = stdout.trim();

  // Collect every tag offset once. Pairing each close with each open is a Θ(K²)
  // cross-product of parse attempts; precompute positions and cap total attempts
  // so the scan stays linear in stdout size however many times the tag appears.
  const openStarts: number[] = [];
  for (let i = trimmed.indexOf(open); i !== -1; i = trimmed.indexOf(open, i + open.length)) {
    openStarts.push(i);
  }
  const closeStarts: number[] = [];
  for (let i = trimmed.indexOf(close); i !== -1; i = trimmed.indexOf(close, i + close.length)) {
    closeStarts.push(i);
  }

  // For each close tag (latest first) try opening tags outermost-first and accept
  // the first slice that is valid JSON AND validates against the schema; only when
  // none do fall back to an earlier close tag. The payload may embed the literal
  // tag strings, so the real opening tag is the OUTERMOST one before the close, not
  // the last. Two separate blocks can't be conflated: the outermost slice spans the
  // raw intervening tags and fails to parse, so the last well-formed block wins.
  const maxParseAttempts = 200;
  let attempts = 0;
  for (let c = closeStarts.length - 1; c >= 0 && attempts <= maxParseAttempts; c--) {
    const closeStart = closeStarts[c]!;
    for (const openStart of openStarts) {
      if (openStart >= closeStart || ++attempts > maxParseAttempts) {
        break;
      }
      const payload = trimmed.slice(openStart + open.length, closeStart).trim();
      try {
        const verdict = schema.safeParse(JSON.parse(payload));
        if (verdict.success) {
          return verdict.data;
        }
      } catch {
        // Not valid JSON (a tag mention in prose or inside the payload); try an
        // earlier opening tag before this close.
      }
    }
  }

  // No well-formed judge block: fall back to parsing the whole output (a judge that
  // replied with a bare verdict object and no wrapping tags).
  try {
    const verdict = schema.safeParse(JSON.parse(trimmed));
    return verdict.success ? verdict.data : null;
  } catch {
    return null;
  }
};

export const parseJudgeVerdict = (stdout: string): z.infer<typeof judgeVerdictSchema> | null => parseJudgeBlock(stdout, judgeVerdictSchema);

// Generalizable rule vs one-off fact. The weakness this targets: a model will
// rubber-stamp any well-structured "Rule:" as reusable. But the failure mode is
// specifically the ONE-OFF FACT (a bare config value, a single incident, one
// artifact's current shape), NOT repo-specificity — a repo-internal convention or
// pitfall that recurs across that repo's work is genuinely reusable. An earlier
// "breadth of transfer" framing wrongly rejected repo-internal rules and cratered
// agreement on real positives; this version keeps those and rejects only one-offs.
export const buildJudgePrompt = (add: LearningAdd, syntheticSession: string): string =>
  [
    "You are grading whether a learning an agent recorded at the end of a work session is worth keeping for future agents to read before later work.",
    "Keep it (answer \"yes\") if it captures a non-obvious, GENERALIZABLE pattern, pitfall, convention, technique, or decision rule that a future agent would re-apply. This MAY be specific to one repo or domain: a convention, gotcha, or testing technique that recurs across that repo's work still earns its place.",
    "",
    'Discard it (answer "no") only when it is a ONE-OFF that will not re-apply:',
    "- a bare fact about one artifact's current shape (one component's memo dependency, one page's tab order, one function's line number);",
    "- a single config value or environment detail (a port, a worker count, a fixed batch limit);",
    '- a single incident with no transferable rule ("PR #X\'s flaky test was a missing await");',
    "- obvious advice, or a restatement/timeline of this one task.",
    'A well-written "Rule:" heading does not make a one-off fact generalizable; conversely, a repo-specific rule IS generalizable when the same situation recurs across that repo\'s tasks.',
    "",
    "The session that produced it:",
    syntheticSession.trim(),
    "",
    "The learning under review:",
    `Title: ${add.title}`,
    `Confidence: ${add.confidence}`,
    `Tags: ${add.tags.join(", ")}`,
    "Content:",
    add.content,
    "",
    "Reply with ONLY this block and nothing else:",
    '<judge>{"verdict": "yes" | "no", "rationale": "<one sentence: the generalizable rule it captures, or why it is a one-off>"}</judge>',
  ].join("\n");

/**
 * LLM-as-judge quality grader. ADVISORY: reported but does not gate a sample's
 * pass, because an uncalibrated judge must not fail a sample on its own — it has
 * no measured agreement (TPR/TNR) with human labels yet. Runs only for cases
 * that expect a learning, and only when the harness injected a model call
 * (`--no-judge` disables it).
 */
export const judgeGrader: Grader<LearningExpect> = {
  name: "quality",
  advisory: true,
  grade: async ({ evalCase, result, invokeModel }) => {
    if (evalCase.expect.decision !== "learning") {
      return pass("quality", "n/a (no learning expected)");
    }
    if (!result) {
      return fail("quality", "no parseable result to judge");
    }
    const adds = learningAdds(result);
    if (adds.length === 0) {
      return fail("quality", "expected a learning to judge but found no add mutation");
    }
    if (!invokeModel) {
      return pass("quality", "judge skipped (--no-judge)");
    }

    const add = adds[0]!;
    const verdict = parseJudgeVerdict(await invokeModel(buildJudgePrompt(add, completedSession(evalCase))));
    if (!verdict) {
      return fail("quality", "could not parse a judge verdict from the judge model output");
    }
    return verdict.verdict === "yes" ? pass("quality", verdict.rationale) : fail("quality", verdict.rationale);
  },
};

/** Graders applied to each learning-policy sample, deterministic first, advisory last. */
export const learningWritebackGraders: Grader<LearningExpect>[] = [schemaGrader, emitsExpectedGrader, tagsGrader, structureGrader, scopeGrader, judgeGrader];

// ───────────────────────────── summary-policy ─────────────────────────────
//
// Graders for the `summary` field the summary-policy fragment produces. The
// worker-result schema only enforces `summary` is non-empty (worker-result.ts),
// so the bar — concise, names the meaningful outcome, no operator-hostile jargon
// — is enforced here. The empirical constants are sourced from the error
// analysis of 296 real summaries (`src/eval/analysis/summary-policy-error-analysis.md`).

/**
 * Empirical conciseness ceilings from the GOOD-summary distribution
 * (`src/eval/analysis/summary-policy-error-analysis.md`, "Empirical conciseness bar"):
 *   - standard: ≤3 sentences (216/226 good are 1–3 sent) and ≤450 chars
 *     (p95 of good = 444c). A no_action_needed summary over this is over-long.
 *   - multiPart: relaxed to ≤6 sentences / ≤700 chars for genuinely multi-part
 *     completed work (observed good max 698c/6 sent). These ceilings are NEVER a
 *     floor — a 120c single sentence is the observed concision floor and good.
 */
export const SUMMARY_LENGTH_BARS = {
  standard: { maxSentences: 3, maxChars: 450 },
  multiPart: { maxSentences: 6, maxChars: 700 },
} as const;

// Abbreviations whose trailing dot must not end a sentence. EMPIRICAL closed
// set: a scan of the real 296-summary corpus
// (`rg -o '\b(e\.g|i\.e|etc|vs|incl|approx)\.'` over the 296 harvested summaries
// — local corpus, regenerable via `foreman eval-harvest automation-pilot` — plus
// a broader dotted-letter sweep, ENG-5444 review) found exactly two abbreviation
// shapes in live summaries — `etc.` (×1) and `incl.` (×1). No e.g./i.e./vs./
// approx./U.S.-style forms occur, so per the no-invented-bars rule we mask only
// what is observed; extend this set only from corpus evidence.
const OBSERVED_ABBREVIATIONS = /\b(etc|incl)\./gi;

/**
 * Counts sentences with the splitter caveat from the report: a `.`/`!`/`?` ends
 * a sentence only when followed by whitespace (or end-of-string) AND not part of
 * a decimal/version (`4.11.0`), a dotted identifier (`query.from`), or an
 * observed abbreviation (`etc.`, `incl.`). We strip those shapes before counting
 * so they don't inflate the sentence count.
 */
export const countSentences = (text: string): number => {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  // Neutralise decimals/versions (digit.digit, any depth), dotted identifiers
  // (word.word, any depth), and the observed abbreviations so their dots aren't
  // read as terminators.
  const masked = trimmed
    .replace(/\d+(?:\.\d+)+/g, (match) => match.replace(/\./g, "·"))
    .replace(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+/g, (match) => match.replace(/\./g, "·"))
    .replace(OBSERVED_ABBREVIATIONS, (match) => match.replace(".", "·"));
  // A terminator is . ! ? followed by whitespace or end-of-string.
  const segments = masked.split(/[.!?]+(?:\s+|$)/).filter((segment) => segment.trim().length > 0);
  return segments.length;
};

/** The emitted result's outcome matches what the session warrants. */
export const outcomeGrader: Grader<SummaryExpect> = {
  name: "outcome",
  grade: ({ evalCase, result }) => {
    if (!result) {
      return fail("outcome", "no parseable result to inspect");
    }
    return result.outcome === evalCase.expect.outcome
      ? pass("outcome", `outcome is "${result.outcome}" as expected`)
      : fail("outcome", `expected outcome "${evalCase.expect.outcome}" but got "${result.outcome}"`);
  },
};

/**
 * The summary stays within the case's empirical conciseness ceiling. It is a
 * ceiling, never a floor: a short summary always passes. `lengthBar: "multiPart"`
 * raises the ceiling so the grader does not penalize genuine multi-part completed
 * work (the report's explicit instruction).
 */
export const concisenessGrader: Grader<SummaryExpect> = {
  name: "conciseness",
  grade: ({ evalCase, result }) => {
    if (!result) {
      return fail("conciseness", "no parseable result to inspect");
    }
    const bar = SUMMARY_LENGTH_BARS[evalCase.expect.lengthBar];
    const chars = result.summary.length;
    const sentences = countSentences(result.summary);
    if (chars > bar.maxChars) {
      return fail("conciseness", `summary is ${chars} chars; ${evalCase.expect.lengthBar} ceiling is ${bar.maxChars}`);
    }
    if (sentences > bar.maxSentences) {
      return fail("conciseness", `summary is ${sentences} sentences; ${evalCase.expect.lengthBar} ceiling is ${bar.maxSentences}`);
    }
    return pass("conciseness", `${chars} chars / ${sentences} sentence(s), within the ${evalCase.expect.lengthBar} ceiling`);
  },
};

// Raw GitHub GraphQL review-thread node ids (PRRT_…) are operator-hostile jargon
// per the report's `jargon-id` mode — meaningless in an operator surface. The
// report anchors the mode on PRRT_ ONLY (other shapes may exist but are
// unobserved), so the always-on check stays scoped to that prefix; bare commit
// SHAs are conventional and explicitly NOT flagged.
const OPAQUE_ID_PATTERN = /PRRT_\w+/;

// Mention matching is phrasing-tolerant: lowercase and collapse hyphen/whitespace
// runs to a single space on BOTH haystack and needle, so a needle like
// "shadow database" still matches a summary that writes "shadow-database" (and
// vice versa). Needles should additionally anchor on durable tokens (e.g. "#72"
// rather than "PR #72") so legitimate rephrasings don't fail the case.
export const normalizeForMention = (text: string): string => text.toLowerCase().replace(/[-\s]+/g, " ");

/**
 * The summary contains every `mustMention` substring and none of the
 * `mustNotMention` substrings (both case- and hyphen/whitespace-insensitive),
 * and never an opaque PRRT_ node id (always-on, regardless of `mustNotMention`).
 */
export const mentionGrader: Grader<SummaryExpect> = {
  name: "mentions",
  grade: ({ evalCase, result }) => {
    if (!result) {
      return fail("mentions", "no parseable result to inspect");
    }
    const haystack = normalizeForMention(result.summary);
    for (const needle of evalCase.expect.mustMention ?? []) {
      if (!haystack.includes(normalizeForMention(needle))) {
        return fail("mentions", `summary must mention "${needle}" but does not`);
      }
    }
    for (const needle of evalCase.expect.mustNotMention ?? []) {
      if (haystack.includes(normalizeForMention(needle))) {
        return fail("mentions", `summary must NOT mention "${needle}" but does`);
      }
    }
    const opaque = OPAQUE_ID_PATTERN.exec(result.summary);
    if (opaque) {
      return fail("mentions", `summary leaks an opaque GraphQL node id ("${opaque[0]}") — operator-hostile jargon`);
    }
    return pass("mentions", "all required mentions present, no forbidden substrings or opaque ids");
  },
};

const summaryJudgeVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  reason: z.string().min(1),
});

export const parseSummaryJudgeVerdict = (stdout: string): z.infer<typeof summaryJudgeVerdictSchema> | null => parseJudgeBlock(stdout, summaryJudgeVerdictSchema);

// Binary verdict (not Likert) per current eval practice — see the learning-policy
// judge note above. Targets the one honesty nuance the report's spot-check found
// (a summary asserting full verification when a step was deferred) plus any
// fabrication/overclaim a future trace might surface.
export const buildSummaryJudgePrompt = (syntheticSession: string, summary: string): string =>
  [
    "You are grading whether a one-line work summary an agent emitted at the end of a session faithfully states the MEANINGFUL OUTCOME of that session, without fabricating or overclaiming.",
    'Answer "pass" if the summary states what actually happened and claims no more than the session supports.',
    'Answer "fail" only if the summary fabricates a result that did not happen, or OVERCLAIMS — e.g. asserts full/complete verification when the session left a verification or smoke step deferred or unchecked.',
    "Conciseness and style are NOT under your review — judge only fidelity to the session.",
    "",
    "The session that just happened:",
    syntheticSession.trim(),
    "",
    "The summary under review:",
    summary,
    "",
    "Reply with ONLY this block and nothing else:",
    '<judge>{"verdict": "pass" | "fail", "reason": "<one sentence>"}</judge>',
  ].join("\n");

/**
 * LLM-as-judge fabrication grader. ADVISORY: reported but never gates a sample —
 * an uncalibrated judge must not fail a sample on its own (see calibration
 * README). No-ops to a pass when `invokeModel` is absent (`--no-judge`).
 */
export const summaryJudgeGrader: Grader<SummaryExpect> = {
  name: "fabrication",
  advisory: true,
  grade: async ({ evalCase, result, invokeModel }) => {
    if (!result) {
      return fail("fabrication", "no parseable result to judge");
    }
    if (!invokeModel) {
      return pass("fabrication", "judge skipped (--no-judge)");
    }
    const verdict = parseSummaryJudgeVerdict(await invokeModel(buildSummaryJudgePrompt(completedSession(evalCase), result.summary)));
    if (!verdict) {
      return fail("fabrication", "could not parse a judge verdict from the judge model output");
    }
    return verdict.verdict === "pass" ? pass("fabrication", verdict.reason) : fail("fabrication", verdict.reason);
  },
};

/** Graders applied to each summary-policy sample, deterministic first, advisory last. */
export const summaryPolicyGraders: Grader<SummaryExpect>[] = [makeSchemaGrader<SummaryExpect>(), outcomeGrader, concisenessGrader, mentionGrader, summaryJudgeGrader];
