import { describe, expect, it } from "vitest";

import { reviewerCases } from "../cases/reviewer.js";
import { syntheticPrReviewBlock, syntheticSessionBlock } from "../run.js";

// The fixture directive blocks are the harness's contract with the model under
// eval: the completed-session block must stay byte-stable across the fixture-union
// migration (the learning/summary evals were calibrated against it), and the
// pr-review block must hand over the discovery material while forbidding the live
// discovery the reviewer template otherwise instructs.

describe("syntheticSessionBlock", () => {
  describe("when wrapping a completed-session fixture", () => {
    it("keeps the pre-migration directive text and embeds the session", () => {
      const block = syntheticSessionBlock("Did the work.\nVerified it.");
      expect(block).toContain("## Eval Harness Directive (simulated session)");
      expect(block).toContain("The implementation work for the task above is COMPLETE.");
      expect(block).toContain("Did the work.\nVerified it.");
      expect(block).toContain("emit exactly one final <agent-result> block with no prose after the closing tag");
    });
  });
});

describe("syntheticPrReviewBlock", () => {
  const fixture = reviewerCases[0]!.fixture;
  if (fixture.type !== "pr-review") {
    throw new Error("reviewer cases must carry pr-review fixtures");
  }
  const block = syntheticPrReviewBlock(fixture);

  describe("when handing the reviewer its discovery material", () => {
    it("embeds the case's discovery verbatim", () => {
      expect(block).toContain(fixture.discovery.trim());
    });

    it("forbids live gh/git discovery and subagent fan-out", () => {
      expect(block).toContain("do NOT run `gh` or any git discovery commands");
      expect(block).toContain("Do not dispatch review subagents or fan out skills");
    });

    it("requires exactly one validated final result block", () => {
      expect(block).toContain("`agent-result validate`");
      expect(block).toContain("emit exactly one final <agent-result> block with no prose after the closing tag");
    });
  });
});

describe("reviewerCases fixtures", () => {
  it("every reviewer case carries a pr-review fixture with a non-empty discovery", () => {
    for (const evalCase of reviewerCases) {
      expect(evalCase.action).toBe("reviewer");
      expect(evalCase.fixture.type).toBe("pr-review");
      if (evalCase.fixture.type === "pr-review") {
        expect(evalCase.fixture.discovery.trim().length).toBeGreaterThan(0);
        expect(evalCase.fixture.pullRequestReference.provider).toBe("github");
      }
    }
  });

  it("continuation cases carry a pre-resolved prior checkpoint", () => {
    for (const evalCase of reviewerCases) {
      if (evalCase.fixture.type === "pr-review" && evalCase.fixture.continuation) {
        expect(evalCase.fixture.priorCheckpoint).toBeDefined();
      }
    }
  });
});
