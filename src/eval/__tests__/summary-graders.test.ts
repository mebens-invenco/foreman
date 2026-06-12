import { describe, expect, it } from "vitest";

import type { WorkerResult } from "../../domain/index.js";
import type { SummaryExpect } from "../cases/summary-policy.js";
import { summaryPolicyCases } from "../cases/summary-policy.js";
import {
  concisenessGrader,
  countSentences,
  mentionGrader,
  outcomeGrader,
  summaryJudgeGrader,
} from "../graders.js";
import type { EvalCase, GradeContext, Grader } from "../types.js";

// Deterministic graders only — the fabrication judge runs a live model and is
// exercised by the opt-in `foreman eval` smoke run, not here. These verify the
// empirical conciseness bar, the mention checks, outcome-match, and PRRT_
// detection — the dimensions the non-empty-only worker-result schema lets through.

const baseCase = summaryPolicyCases[0]!;
const makeCase = (
  over: Partial<EvalCase<SummaryExpect>>,
): EvalCase<SummaryExpect> => ({ ...baseCase, ...over });

const makeResult = (
  summary: string,
  outcome: WorkerResult["outcome"] = "completed",
): WorkerResult => ({
  schemaVersion: 1,
  action: "execution",
  outcome,
  summary,
  taskMutations: [],
  reviewMutations: [],
  learningMutations: [],
  blockers: [],
  signals: [],
});

const ctxFor = (
  evalCase: EvalCase<SummaryExpect>,
  result: WorkerResult | null,
): GradeContext<SummaryExpect> => ({
  evalCase,
  result,
  rawStdout: "",
  ...(result ? {} : { parseError: "parse failed" }),
});

const passOf = async (
  grader: Grader<SummaryExpect>,
  ctx: GradeContext<SummaryExpect>,
): Promise<boolean> => (await grader.grade(ctx)).pass;

// Build sentences of a fixed shape so a count test isn't accidentally tripped by
// the char ceiling (and vice versa).
const sentences = (n: number): string =>
  Array.from(
    { length: n },
    (_, i) => `Outcome fact number ${i + 1} is done.`,
  ).join(" ");

describe("countSentences", () => {
  describe("when counting plain prose", () => {
    it("counts terminator-delimited sentences", () => {
      expect(countSentences("Did the thing. Verified it. Pushed.")).toBe(3);
    });

    it("counts a single trailing sentence with no terminator", () => {
      expect(
        countSentences("Wired the env var so Datadog reports the deployed SHA"),
      ).toBe(1);
    });
  });

  describe("when protecting decimals and dotted identifiers", () => {
    it("does not split on a decimal/version interior dot", () => {
      // "all 2145 tests pass on 4.11.0" must read as ONE sentence, not three.
      expect(
        countSentences("Upgraded to 4.11.0 and all 2145 tests pass."),
      ).toBe(1);
    });

    it("does not split on a dotted identifier interior dot", () => {
      // query.from / existing.set(...) interior dots must not inflate the count.
      expect(
        countSentences(
          "Kept the getByCarrierServices lookup and the existing.set(...) merge.",
        ),
      ).toBe(1);
    });
  });

  describe("when protecting observed abbreviations", () => {
    // The masked set is the EMPIRICAL closed set found in the real 296-summary
    // corpus (etc. ×1, incl. ×1 — see OBSERVED_ABBREVIATIONS in graders.ts). A
    // mid-sentence abbreviation dot must not push a genuinely concise summary
    // over the 3-sentence standard ceiling (false conciseness failures).
    it("does not split on a mid-sentence 'etc.'", () => {
      expect(
        countSentences(
          "Cleaned the helpers, tests, etc. and pushed the branch.",
        ),
      ).toBe(1);
    });

    it("does not split on a mid-sentence 'incl.'", () => {
      expect(
        countSentences(
          "State hardening is correct and well-tested (incl. a deployable-gap regression pin) and complete.",
        ),
      ).toBe(1);
    });
  });
});

describe("outcomeGrader", () => {
  describe("when the emitted outcome matches the expectation", () => {
    it("passes", async () => {
      const evalCase = makeCase({
        expect: { outcome: "completed", lengthBar: "standard" },
      });
      expect(
        await passOf(
          outcomeGrader,
          ctxFor(evalCase, makeResult("Did it.", "completed")),
        ),
      ).toBe(true);
    });
  });

  describe("when the emitted outcome differs", () => {
    it("fails", async () => {
      const evalCase = makeCase({
        expect: { outcome: "no_action_needed", lengthBar: "standard" },
      });
      expect(
        await passOf(
          outcomeGrader,
          ctxFor(evalCase, makeResult("Did it.", "completed")),
        ),
      ).toBe(false);
    });
  });

  it("fails when there is no parseable result", async () => {
    expect(await passOf(outcomeGrader, ctxFor(baseCase, null))).toBe(false);
  });
});

describe("concisenessGrader", () => {
  describe("on the standard bar", () => {
    const standardCase = makeCase({
      expect: { outcome: "completed", lengthBar: "standard" },
    });

    it("passes a 3-sentence summary (at the ceiling)", async () => {
      expect(
        await passOf(
          concisenessGrader,
          ctxFor(standardCase, makeResult(sentences(3))),
        ),
      ).toBe(true);
    });

    it("fails a 4-sentence summary (over the sentence ceiling)", async () => {
      expect(
        await passOf(
          concisenessGrader,
          ctxFor(standardCase, makeResult(sentences(4))),
        ),
      ).toBe(false);
    });

    it("fails a summary over the 450-char ceiling even at 3 sentences", async () => {
      const padded = `${"x".repeat(460)}. Two. Three.`;
      expect(
        await passOf(
          concisenessGrader,
          ctxFor(standardCase, makeResult(padded)),
        ),
      ).toBe(false);
    });

    it("passes a tight single short sentence (ceiling is never a floor)", async () => {
      expect(
        await passOf(
          concisenessGrader,
          ctxFor(
            standardCase,
            makeResult("Pure deletion, no behavior change."),
          ),
        ),
      ).toBe(true);
    });
  });

  describe("on the multiPart bar", () => {
    const multiPartCase = makeCase({
      expect: { outcome: "completed", lengthBar: "multiPart" },
    });

    it("passes a 6-sentence multi-part summary the standard bar would reject", async () => {
      const sixSent = makeResult(sentences(6));
      expect(
        await passOf(
          concisenessGrader,
          ctxFor(
            makeCase({
              expect: { outcome: "completed", lengthBar: "standard" },
            }),
            sixSent,
          ),
        ),
      ).toBe(false);
      expect(
        await passOf(concisenessGrader, ctxFor(multiPartCase, sixSent)),
      ).toBe(true);
    });

    it("fails a 7-sentence summary (over even the multiPart ceiling)", async () => {
      expect(
        await passOf(
          concisenessGrader,
          ctxFor(multiPartCase, makeResult(sentences(7))),
        ),
      ).toBe(false);
    });

    it("enforces the 700-char ceiling: 698 chars passes (observed good max), 701 fails", async () => {
      // Pins the ceiling to its provenance: the longest GOOD multi-part summary
      // in the corpus is 698c/6 sent (01KSRH1WJPQ7ZSS30FKV2T8GZB), so 698 must
      // pass and anything past the 700 ceiling must fail at the same 6 sentences.
      const sixSentencesOfLength = (chars: number): string => {
        const head = "One. Two. Three. Four. Five. ";
        return `${head}${"x".repeat(chars - head.length - 1)}.`;
      };
      expect(sixSentencesOfLength(698)).toHaveLength(698);
      expect(
        await passOf(
          concisenessGrader,
          ctxFor(multiPartCase, makeResult(sixSentencesOfLength(698))),
        ),
      ).toBe(true);
      expect(
        await passOf(
          concisenessGrader,
          ctxFor(multiPartCase, makeResult(sixSentencesOfLength(701))),
        ),
      ).toBe(false);
    });
  });

  it("fails when there is no parseable result", async () => {
    expect(await passOf(concisenessGrader, ctxFor(baseCase, null))).toBe(false);
  });
});

describe("mentionGrader", () => {
  describe("mustMention", () => {
    const mustCase = makeCase({
      expect: {
        outcome: "blocked",
        lengthBar: "standard",
        mustMention: ["PR #72", "scope"],
      },
    });

    it("passes when every required substring is present (case-insensitive)", async () => {
      expect(
        await passOf(
          mentionGrader,
          ctxFor(
            mustCase,
            makeResult(
              "Blocked: maintainer closed pr #72 as a SCOPE pause.",
              "blocked",
            ),
          ),
        ),
      ).toBe(true);
    });

    it("fails when a required substring is missing", async () => {
      expect(
        await passOf(
          mentionGrader,
          ctxFor(mustCase, makeResult("Blocked on PR #72.", "blocked")),
        ),
      ).toBe(false);
    });
  });

  describe("hyphen/whitespace normalization", () => {
    // The grader normalizes BOTH haystack and needle (lowercase + collapse
    // hyphen/whitespace runs to one space) so a case needle doesn't fail on a
    // legitimate rephrasing — the whole point of mention checks is durable
    // facts, not exact wording.
    const shadowCase = makeCase({
      expect: {
        outcome: "blocked",
        lengthBar: "standard",
        mustMention: ["shadow database"],
      },
    });

    it("matches a hyphenated summary phrasing against a spaced needle", async () => {
      expect(
        await passOf(
          mentionGrader,
          ctxFor(
            shadowCase,
            makeResult("Blocked: the shadow-database is unreachable.", "blocked"),
          ),
        ),
      ).toBe(true);
    });

    it("matches a '#72' needle across PR-reference phrasings", async () => {
      const prCase = makeCase({
        expect: {
          outcome: "blocked",
          lengthBar: "standard",
          mustMention: ["#72"],
        },
      });
      expect(
        await passOf(
          mentionGrader,
          ctxFor(prCase, makeResult("Blocked: maintainer closed PR#72.", "blocked")),
        ),
      ).toBe(true);
      expect(
        await passOf(
          mentionGrader,
          ctxFor(prCase, makeResult("Blocked: pull request #72 was closed.", "blocked")),
        ),
      ).toBe(true);
    });

    it("applies the same normalization to mustNotMention (no asymmetry)", async () => {
      const forbidCase = makeCase({
        expect: {
          outcome: "completed",
          lengthBar: "standard",
          mustNotMention: ["shadow database"],
        },
      });
      expect(
        await passOf(
          mentionGrader,
          ctxFor(forbidCase, makeResult("Mentioned the shadow-database in passing.")),
        ),
      ).toBe(false);
    });

    it("leaves underscore identifiers intact (normalization touches only hyphens/whitespace)", async () => {
      // Exact-token needles (snake_case identifiers, PRRT_ ids) must keep
      // matching: the collapse is limited to `[-\s]+` and applied symmetrically.
      const idCase = makeCase({
        expect: {
          outcome: "completed",
          lengthBar: "standard",
          mustMention: ["carrier_rate_cache"],
        },
      });
      expect(
        await passOf(
          mentionGrader,
          ctxFor(idCase, makeResult("Added the composite index on carrier_rate_cache.")),
        ),
      ).toBe(true);
    });
  });

  describe("mustNotMention", () => {
    const mustNotCase = makeCase({
      expect: {
        outcome: "completed",
        lengthBar: "multiPart",
        mustNotMention: ["fully verified"],
      },
    });

    it("fails when a forbidden substring is present (case-insensitive)", async () => {
      expect(
        await passOf(
          mentionGrader,
          ctxFor(
            mustNotCase,
            makeResult("Added the surface; Fully Verified across all paths."),
          ),
        ),
      ).toBe(false);
    });

    it("passes when honest hedging avoids the forbidden claim", async () => {
      expect(
        await passOf(
          mentionGrader,
          ctxFor(
            mustNotCase,
            makeResult(
              "Added the surface; automated suite passes for the affected scope, manual smoke deferred.",
            ),
          ),
        ),
      ).toBe(true);
    });
  });

  describe("opaque PRRT_ id detection (always-on)", () => {
    const cleanCase = makeCase({
      expect: { outcome: "no_action_needed", lengthBar: "standard" },
    });

    it("fails when a raw PRRT_ node id leaks into the summary", async () => {
      expect(
        await passOf(
          mentionGrader,
          ctxFor(
            cleanCase,
            makeResult(
              "No new activity since PRRT_kwDOFAQ9Cs6Fk40a; nothing actionable.",
              "no_action_needed",
            ),
          ),
        ),
      ).toBe(false);
    });

    it("passes a clean stand-down that names the outcome without the id", async () => {
      expect(
        await passOf(
          mentionGrader,
          ctxFor(
            cleanCase,
            makeResult(
              "No new maintainer activity; PR remains approved, nothing actionable this pass.",
              "no_action_needed",
            ),
          ),
        ),
      ).toBe(true);
    });

    it("does not flag a bare commit SHA (conventional, greppable, not jargon)", async () => {
      expect(
        await passOf(
          mentionGrader,
          ctxFor(
            cleanCase,
            makeResult(
              "Head unchanged at 621c308f; nothing actionable.",
              "no_action_needed",
            ),
          ),
        ),
      ).toBe(true);
    });
  });

  it("fails when there is no parseable result", async () => {
    expect(await passOf(mentionGrader, ctxFor(baseCase, null))).toBe(false);
  });
});

describe("summaryJudgeGrader", () => {
  it("is advisory (does not gate a sample's pass)", () => {
    expect(summaryJudgeGrader.advisory).toBe(true);
  });

  it("no-ops to a pass when no invokeModel is injected (--no-judge)", async () => {
    // Without a live model the advisory judge must not fail a sample on its own.
    expect(
      await passOf(
        summaryJudgeGrader,
        ctxFor(baseCase, makeResult("Did the thing.")),
      ),
    ).toBe(true);
  });

  it("fails when there is no parseable result to judge", async () => {
    expect(await passOf(summaryJudgeGrader, ctxFor(baseCase, null))).toBe(
      false,
    );
  });
});
