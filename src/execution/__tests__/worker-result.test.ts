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
