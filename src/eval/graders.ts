import { z } from "zod";

import type { WorkerResult } from "../domain/index.js";
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
export const schemaGrader: Grader = {
  name: "schema",
  grade: ({ result, parseError }) =>
    result
      ? pass("schema", "parsed and validated against the worker-result schema")
      : fail("schema", `did not parse/validate: ${parseError ?? "unknown error"}`),
};

/** The learning-review decision matches what the case expects. */
export const emitsExpectedGrader: Grader = {
  name: "emits-expected",
  grade: ({ evalCase, result }) => {
    if (!result) {
      return fail("emits-expected", "no parseable result to inspect");
    }
    const count = result.learningMutations.length;
    if (evalCase.expect === "learning") {
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
export const tagsGrader: Grader = {
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
export const structureGrader: Grader = {
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

// Binary verdict, not a 1-5 Likert: per current eval practice (Hamel/Shreya),
// binary judgments label more consistently across runs than Likert points whose
// boundaries drift between annotators and samples. The judge is also ADVISORY
// until calibrated against human labels (TPR/TNR) — see judgeGrader.advisory —
// so it never fails a sample on its own.
const judgeVerdictSchema = z.object({
  verdict: z.enum(["yes", "no"]),
  rationale: z.string().min(1),
});

const parseJudgeVerdict = (stdout: string): z.infer<typeof judgeVerdictSchema> | null => {
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

const buildJudgePrompt = (add: LearningAdd, syntheticSession: string): string =>
  [
    "You are grading the QUALITY of a learning an agent recorded at the end of a work session.",
    "Answer one yes/no question about the learning below.",
    "Is it a non-obvious, reusable pattern or decision rule that would help a FUTURE agent on a DIFFERENT task — as opposed to a restatement of this one task, or something too obvious or one-off to be worth keeping?",
    'Answer "yes" only if it is reusable AND non-obvious AND phrased as a general pattern/rule rather than a timeline of this one task. Otherwise answer "no".',
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
    'Reply with ONLY this block and nothing else:',
    '<judge>{"verdict": "yes" | "no", "rationale": "<one sentence>"}</judge>',
  ].join("\n");

/**
 * LLM-as-judge quality grader. ADVISORY: reported but does not gate a sample's
 * pass, because an uncalibrated judge must not fail a sample on its own — it has
 * no measured agreement (TPR/TNR) with human labels yet. Runs only for cases
 * that expect a learning, and only when the harness injected a model call
 * (`--no-judge` disables it).
 */
export const judgeGrader: Grader = {
  name: "quality",
  advisory: true,
  grade: async ({ evalCase, result, invokeModel }) => {
    if (evalCase.expect !== "learning") {
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

/** Graders applied to each learning-policy sample, deterministic first. */
export const learningWritebackGraders: Grader[] = [schemaGrader, emitsExpectedGrader, tagsGrader, structureGrader, judgeGrader];
