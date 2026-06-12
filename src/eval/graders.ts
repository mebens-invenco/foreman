import { z } from "zod";

import type { WorkerResult } from "../domain/index.js";
import type { LearningExpect } from "./cases/learning-policy.js";
import type { Grader, GraderResult } from "./types.js";

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

/** Parsed + validated against the action-specific worker-result schema. */
export const schemaGrader: Grader<LearningExpect> = {
  name: "schema",
  grade: ({ result, parseError }) =>
    result
      ? pass("schema", "parsed and validated against the worker-result schema")
      : fail("schema", `did not parse/validate: ${parseError ?? "unknown error"}`),
};

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

export const parseJudgeVerdict = (stdout: string): z.infer<typeof judgeVerdictSchema> | null => {
  const open = "<judge>";
  const close = "</judge>";
  const openStart = stdout.lastIndexOf(open);
  const closeStart = stdout.lastIndexOf(close);
  const payload = openStart !== -1 && closeStart > openStart ? stdout.slice(openStart + open.length, closeStart).trim() : stdout.trim();

  try {
    const verdict = judgeVerdictSchema.safeParse(JSON.parse(payload));
    return verdict.success ? verdict.data : null;
  } catch {
    return null;
  }
};

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
    const verdict = parseJudgeVerdict(await invokeModel(buildJudgePrompt(add, evalCase.syntheticSession)));
    if (!verdict) {
      return fail("quality", "could not parse a judge verdict from the judge model output");
    }
    return verdict.verdict === "yes" ? pass("quality", verdict.rationale) : fail("quality", verdict.rationale);
  },
};

/** Graders applied to each learning-policy sample, deterministic first, advisory last. */
export const learningWritebackGraders: Grader<LearningExpect>[] = [schemaGrader, emitsExpectedGrader, tagsGrader, structureGrader, scopeGrader, judgeGrader];
