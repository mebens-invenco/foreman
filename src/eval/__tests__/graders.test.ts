import { describe, expect, it } from "vitest";

import type { WorkerResult } from "../../domain/index.js";
import { learningPolicyCases } from "../cases/learning-policy.js";
import { emitsExpectedGrader, schemaGrader, scopeGrader, structureGrader, tagsGrader } from "../graders.js";
import type { EvalCase, GradeContext, Grader } from "../types.js";

// Deterministic graders only — the judge runs a live model and is exercised by
// the opt-in `foreman eval` smoke run, not here. These verify that the cheap
// graders flag exactly what the loose worker-result schema lets through.

const baseCase = learningPolicyCases[0]!;
const makeCase = (over: Partial<EvalCase>): EvalCase => ({ ...baseCase, ...over });

const makeResult = (learningMutations: WorkerResult["learningMutations"]): WorkerResult => ({
  schemaVersion: 1,
  action: "execution",
  outcome: "completed",
  summary: "did the thing",
  taskMutations: [],
  reviewMutations: [],
  learningMutations,
  blockers: [],
  signals: [],
});

const goodAdd: WorkerResult["learningMutations"][number] = {
  type: "add",
  title: "Linear GraphQL throttling returns 200 + RATELIMITED",
  repo: "shared",
  confidence: "emerging",
  content: "**Rule:** retry Linear GraphQL on a body-level RATELIMITED error.\n**When to apply:** any Linear GraphQL caller.",
  tags: ["execution", "high-impact"],
};

const ctxFor = (evalCase: EvalCase, result: WorkerResult | null): GradeContext => ({
  evalCase,
  result,
  rawStdout: "",
  ...(result ? {} : { parseError: "parse failed" }),
});

const passOf = async (grader: Grader, ctx: GradeContext): Promise<boolean> => (await grader.grade(ctx)).pass;

describe("schemaGrader", () => {
  it("passes when the result parsed and validated", async () => {
    expect(await passOf(schemaGrader, ctxFor(baseCase, makeResult([goodAdd])))).toBe(true);
  });

  it("fails when there is no parseable result", async () => {
    expect(await passOf(schemaGrader, ctxFor(baseCase, null))).toBe(false);
  });
});

describe("emitsExpectedGrader", () => {
  const learningCase = makeCase({ expect: "learning" });
  const noLearningCase = makeCase({ expect: "no_learning" });

  it("passes when a learning was expected and emitted", async () => {
    expect(await passOf(emitsExpectedGrader, ctxFor(learningCase, makeResult([goodAdd])))).toBe(true);
  });

  it("fails when a learning was expected but none emitted", async () => {
    expect(await passOf(emitsExpectedGrader, ctxFor(learningCase, makeResult([])))).toBe(false);
  });

  it("passes when no learning was expected and none emitted", async () => {
    expect(await passOf(emitsExpectedGrader, ctxFor(noLearningCase, makeResult([])))).toBe(true);
  });

  it("fails when no learning was expected but one was emitted", async () => {
    expect(await passOf(emitsExpectedGrader, ctxFor(noLearningCase, makeResult([goodAdd])))).toBe(false);
  });
});

describe("tagsGrader", () => {
  const executionCase = makeCase({ action: "execution" });

  it("passes with a single action tag matching the run action", async () => {
    expect(await passOf(tagsGrader, ctxFor(executionCase, makeResult([goodAdd])))).toBe(true);
  });

  it("passes when extra action-name tags appear as topics but the surfacing action is present", async () => {
    // Captured from a live claude smoke run: the model tagged execution + retry
    // plus topic words. The contract is "at least one action tag including the
    // surfacing action", not exactly one — so this must pass.
    const overTagged = { ...goodAdd, tags: ["execution", "high-impact", "silent-failure", "linear", "graphql", "rate-limit", "retry"] };
    expect(await passOf(tagsGrader, ctxFor(executionCase, makeResult([overTagged])))).toBe(true);
  });

  it("fails with empty tags", async () => {
    expect(await passOf(tagsGrader, ctxFor(executionCase, makeResult([{ ...goodAdd, tags: [] }])))).toBe(false);
  });

  it("fails when no action tag is present", async () => {
    expect(await passOf(tagsGrader, ctxFor(executionCase, makeResult([{ ...goodAdd, tags: ["high-impact"] }])))).toBe(false);
  });

  it("fails when the action tag does not match the run action", async () => {
    expect(await passOf(tagsGrader, ctxFor(executionCase, makeResult([{ ...goodAdd, tags: ["review"] }])))).toBe(false);
  });
});

describe("structureGrader", () => {
  const executionCase = makeCase({ action: "execution" });

  it("passes when Rule and When-to-apply markers are present", async () => {
    expect(await passOf(structureGrader, ctxFor(executionCase, makeResult([goodAdd])))).toBe(true);
  });

  it("fails when a required content marker is missing", async () => {
    const noWhen = { ...goodAdd, content: "**Rule:** retry on RATELIMITED." };
    expect(await passOf(structureGrader, ctxFor(executionCase, makeResult([noWhen])))).toBe(false);
  });
});

describe("scopeGrader", () => {
  const repoAdd = { ...goodAdd, repo: "lynk-frontend" }; // goodAdd is repo "shared"

  it("passes (n/a) when the case sets no scope expectation", async () => {
    expect(await passOf(scopeGrader, ctxFor(makeCase({}), makeResult([repoAdd])))).toBe(true);
  });

  it("passes (n/a) when a scope is expected but no learning was emitted", async () => {
    expect(await passOf(scopeGrader, ctxFor(makeCase({ expectScope: "shared" }), makeResult([])))).toBe(true);
  });

  it("passes when shared is expected and the learning is scoped shared", async () => {
    expect(await passOf(scopeGrader, ctxFor(makeCase({ expectScope: "shared" }), makeResult([goodAdd])))).toBe(true);
  });

  it("fails when shared is expected but the learning is scoped to a specific repo", async () => {
    expect(await passOf(scopeGrader, ctxFor(makeCase({ expectScope: "shared" }), makeResult([repoAdd])))).toBe(false);
  });

  it("passes when repo-specific is expected and the learning is scoped to a repo", async () => {
    expect(await passOf(scopeGrader, ctxFor(makeCase({ expectScope: "repo-specific" }), makeResult([repoAdd])))).toBe(true);
  });

  it("fails when repo-specific is expected but the learning is scoped shared", async () => {
    expect(await passOf(scopeGrader, ctxFor(makeCase({ expectScope: "repo-specific" }), makeResult([goodAdd])))).toBe(false);
  });

  it("is advisory (does not gate a sample's pass)", () => {
    expect(scopeGrader.advisory).toBe(true);
  });
});
