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
    // Mirrors the real failure (ENG-5450): a reviewer recorded a learning whose
    // content describes the agent-result mechanism, so the emitted JSON itself
    // embeds the literal "<agent-result>" string. The backward scan latched onto
    // that in-payload mention and dropped the otherwise-valid block.
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
});
