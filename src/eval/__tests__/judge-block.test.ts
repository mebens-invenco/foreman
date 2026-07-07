import { describe, expect, test } from "vitest";

import { parseJudgeVerdict, parseSummaryJudgeVerdict } from "../graders.js";

// The shared <judge>…</judge> extractor (parseJudgeBlock, exercised here through
// its two public parsers) is the same class of tag-in-payload bug ENG-5450 fixed
// in parseWorkerResult: a judge verdict is model output that can echo the literal
// <judge> delimiter, and a naive lastIndexOf(open) latches onto the in-payload
// mention and drops an otherwise valid verdict.

describe("parseJudgeVerdict", () => {
  test("parses a well-formed judge block", () => {
    expect(parseJudgeVerdict('<judge>{"verdict": "yes", "rationale": "captures a reusable rule"}</judge>')).toEqual({
      verdict: "yes",
      rationale: "captures a reusable rule",
    });
  });

  test("falls back to a bare verdict object with no wrapping tags", () => {
    // The judge sometimes replies with just the JSON object; the whole-output
    // fallback must still validate it.
    expect(parseJudgeVerdict('{"verdict": "no", "rationale": "just a one-off fact"}')).toEqual({
      verdict: "no",
      rationale: "just a one-off fact",
    });
  });

  test("uses the final judge block when earlier prose mentions the tag", () => {
    expect(
      parseJudgeVerdict(
        [
          "Reply with ONLY the <judge> block, so here it is:",
          '<judge>{"verdict": "yes", "rationale": "final verdict"}</judge>',
        ].join("\n"),
      ),
    ).toEqual({ verdict: "yes", rationale: "final verdict" });
  });

  test("extracts the verdict when the rationale embeds the literal <judge> open tag", () => {
    // A rationale that quotes the delimiter it was told to emit makes the JSON
    // itself embed the literal "<judge>" string. The scan must not latch onto that
    // in-payload mention and drop the valid verdict.
    const verdict = {
      verdict: "yes",
      rationale: "The learning explains how to reply with the <judge> block, which is a reusable convention.",
    };
    const payload = JSON.stringify(verdict);
    // Guard the regression intent: the payload really does embed the open tag.
    expect(payload).toContain("<judge>");

    expect(parseJudgeVerdict(`<judge>${payload}</judge>`)).toEqual(verdict);
  });

  test("extracts the verdict when the rationale embeds the literal </judge> closing tag", () => {
    // Quoting the wrapper in full embeds the closing "</judge>" tag in the content
    // too; correctness hinges on the close-tag search resolving to the real final
    // closing tag rather than the in-payload mention.
    const verdict = {
      verdict: "no",
      rationale: "The content quotes the full <judge>{...}</judge> wrapper, so the JSON embeds </judge> literally.",
    };
    const payload = JSON.stringify(verdict);
    // Guard the regression intent: the payload embeds the closing tag before the real one.
    expect(payload).toContain("</judge>");

    expect(parseJudgeVerdict(`<judge>${payload}</judge>`)).toEqual(verdict);
  });

  test("skips an invalid trailing block and falls back to an earlier valid block", () => {
    expect(
      parseJudgeVerdict(
        [
          '<judge>{"verdict": "yes", "rationale": "earlier valid verdict"}</judge>',
          "<judge>not json</judge>",
        ].join("\n"),
      ),
    ).toEqual({ verdict: "yes", rationale: "earlier valid verdict" });
  });

  test("returns null when a block parses as JSON but is not a verdict", () => {
    expect(parseJudgeVerdict('<judge>{"foo": "bar"}</judge>')).toBeNull();
  });

  test("returns null when there is no parseable verdict", () => {
    expect(parseJudgeVerdict("I could not decide.")).toBeNull();
  });

  test("bounds parse attempts on a pathological many-mention payload (no quadratic blowup)", () => {
    // The tag-scan must not degrade to a close×open cross-product when stdout echoes
    // the tag many times without a valid block. This no-verdict payload has thousands
    // of tag pairs: near-instant with the parse-attempt cap, seconds without it.
    const pathological = "<judge>x</judge>".repeat(4000);

    const start = performance.now();
    expect(parseJudgeVerdict(pathological)).toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("parseSummaryJudgeVerdict", () => {
  test("parses a well-formed judge block", () => {
    expect(parseSummaryJudgeVerdict('<judge>{"verdict": "pass", "reason": "faithful to the session"}</judge>')).toEqual({
      verdict: "pass",
      reason: "faithful to the session",
    });
  });

  test("extracts the verdict when the reason embeds the literal <judge> / </judge> tags", () => {
    // The summary judge uses a different schema (pass|fail + reason) but shares the
    // same extractor, so it inherits the same tag-in-payload fix.
    const verdict = {
      verdict: "fail",
      reason: "The summary quotes the full <judge>{...}</judge> instruction verbatim instead of stating the outcome.",
    };
    const payload = JSON.stringify(verdict);
    // Guard the regression intent: the payload embeds both the open and close tags.
    expect(payload).toContain("<judge>");
    expect(payload).toContain("</judge>");

    expect(parseSummaryJudgeVerdict(`<judge>${payload}</judge>`)).toEqual(verdict);
  });
});
