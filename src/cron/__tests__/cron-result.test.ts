import { describe, expect, test } from "vitest";

import { parseCronResult } from "../cron-result.js";

describe("parseCronResult", () => {
  test("keeps natural-language cron output valid", () => {
    expect(parseCronResult("No follow-up work was found.")).toBeNull();
  });

  test("parses one strict terminating Slack action", () => {
    expect(
      parseCronResult(
        '<cron-result>\n{"schemaVersion":1,"summary":"Scan complete.","action":{"type":"send_slack_dm","text":"Review <https://example.com|the report>."}}\n</cron-result>',
      ),
    ).toEqual({
      schemaVersion: 1,
      summary: "Scan complete.",
      action: { type: "send_slack_dm", text: "Review <https://example.com|the report>." },
    });
  });

  test.each([
    ["malformed JSON", "<cron-result>{</cron-result>"],
    ["non-terminating output", '<cron-result>{"schemaVersion":1}</cron-result> trailing'],
    ["recipient override", '<cron-result>{"schemaVersion":1,"summary":"x","action":{"type":"send_slack_dm","text":"x","channel":"C1"}}</cron-result>'],
    ["multiple actions", '<cron-result>{"schemaVersion":1,"summary":"x","action":[{"type":"send_slack_dm","text":"x"},{"type":"send_slack_dm","text":"y"}]}</cron-result>'],
    ["oversized text", `<cron-result>${JSON.stringify({ schemaVersion: 1, summary: "x", action: { type: "send_slack_dm", text: "x".repeat(4_001) } })}</cron-result>`],
  ])("rejects %s", (_label, output) => {
    expect(() => parseCronResult(output)).toThrow(/Cron (output|result)/);
  });
});
