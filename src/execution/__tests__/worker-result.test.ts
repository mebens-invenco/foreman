import { describe, expect, test } from "vitest";

import { parseWorkerResult, workerResultExample } from "../worker-result.js";

describe("parseWorkerResult", () => {
  test("accepts valid raw JSON output", () => {
    expect(parseWorkerResult(JSON.stringify(workerResultExample))).toEqual(workerResultExample);
  });

  test("uses the final parseable agent-result block when earlier text mentions the tag", () => {
    const finalResult = {
      ...workerResultExample,
      summary: "final result",
    };

    expect(
      parseWorkerResult([
        "I will validate the required `<agent-result>` payload now.",
        `<agent-result>\n${JSON.stringify(finalResult)}\n</agent-result>`,
      ].join("\n")),
    ).toEqual(finalResult);
  });

  test("extracts the block when the payload JSON embeds the literal agent-result tag", () => {
    // A learning whose content describes the agent-result mechanism makes the
    // emitted JSON itself embed the literal "<agent-result>" string. The scan
    // must not latch onto that in-payload mention and drop the valid block.
    const resultWithTagMention = {
      ...workerResultExample,
      outcome: "no_action_needed",
      summary: "Recorded a learning about agent-result handling.",
      learningMutations: [
        {
          type: "add",
          title: "Tag mentions inside the payload",
          repo: "foreman",
          confidence: "emerging",
          content:
            "A worker documenting the <agent-result> wrapper emits JSON whose content " +
            "embeds the literal <agent-result> string; parseWorkerResult must still " +
            "return the enclosing block.",
          tags: ["execution"],
        },
      ],
    };

    const payload = JSON.stringify(resultWithTagMention);
    // Guard the regression intent: the payload really does embed the open tag.
    expect(payload).toContain("<agent-result>");

    expect(parseWorkerResult(`<agent-result>\n${payload}\n</agent-result>`)).toEqual(resultWithTagMention);
  });

  test("extracts the block when the payload JSON embeds the literal closing agent-result tag", () => {
    // A learning that quotes the wrapper in full embeds the closing
    // "</agent-result>" tag in its content too, not just the opening tag.
    // Correctness hinges on the close-tag search resolving to the real final
    // closing tag rather than the in-payload mention.
    const resultWithClosingTagMention = {
      ...workerResultExample,
      outcome: "no_action_needed",
      summary: "Recorded a learning about agent-result handling.",
      learningMutations: [
        {
          type: "add",
          title: "Closing-tag mentions inside the payload",
          repo: "foreman",
          confidence: "emerging",
          content:
            "A worker documenting the wrapper quotes it in full as " +
            "<agent-result>{...}</agent-result>, so the JSON content embeds the literal " +
            "</agent-result> closing tag; parseWorkerResult must still return the enclosing block.",
          tags: ["execution"],
        },
      ],
    };

    const payload = JSON.stringify(resultWithClosingTagMention);
    // Guard the regression intent: the payload embeds the closing tag before the real one.
    expect(payload).toContain("</agent-result>");

    expect(parseWorkerResult(`<agent-result>\n${payload}\n</agent-result>`)).toEqual(resultWithClosingTagMention);
  });

  test("skips invalid trailing blocks and falls back to an earlier valid block", () => {
    const finalResult = {
      ...workerResultExample,
      summary: "earlier valid result",
    };

    expect(
      parseWorkerResult([
        `<agent-result>\n${JSON.stringify(finalResult)}\n</agent-result>`,
        "<agent-result>not json</agent-result>",
      ].join("\n")),
    ).toEqual(finalResult);
  });

  test("rejects natural final text without an agent-result block", () => {
    expect(() => parseWorkerResult("Implemented the change and pushed the branch.")).toThrow(
      "Worker output did not contain a valid <agent-result> block",
    );
  });

  test("returns the block when a JSON string embeds an adjacent close+open tag sequence", () => {
    // When an intervening "</agent-result><agent-result>" sits inside a JSON
    // string, the outermost-open slice is itself valid JSON and is the single
    // intended block — not two separate blocks. Pin that this stays correct.
    const resultWithAdjacentTags = {
      ...workerResultExample,
      outcome: "no_action_needed",
      summary: "Recorded a learning about agent-result handling.",
      learningMutations: [
        {
          type: "add",
          title: "Adjacent wrapper tags inside the payload",
          repo: "foreman",
          confidence: "emerging",
          content:
            "Some workers paste the wrapper as </agent-result><agent-result> when describing " +
            "back-to-back blocks; parseWorkerResult must still return this single block.",
          tags: ["execution"],
        },
      ],
    };

    const payload = JSON.stringify(resultWithAdjacentTags);
    // Guard the regression intent: the payload embeds an adjacent close+open run.
    expect(payload).toContain("</agent-result><agent-result>");

    expect(parseWorkerResult(`<agent-result>\n${payload}\n</agent-result>`)).toEqual(resultWithAdjacentTags);
  });

  test("bounds parse attempts on a pathological many-mention payload (no quadratic blowup)", () => {
    // The tag-scan must not degrade to a close×open cross-product when stdout
    // echoes the tag many times without a valid block — parseWorkerResult runs
    // synchronously on the orchestrator path. This no-valid-block payload has
    // thousands of tag pairs: near-instant with the parse-attempt cap, but Θ(K²)
    // parses (seconds) without it. The wall-clock guard keeps a wide margin to
    // stay non-flaky while still catching a reintroduced quadratic scan.
    const pathological = "<agent-result>x</agent-result>".repeat(4000);

    const start = performance.now();
    expect(() => parseWorkerResult(pathological)).toThrow(
      "Worker output did not contain a valid <agent-result> block",
    );
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
