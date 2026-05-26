import { describe, expect, test } from "vitest";

import { normalizeTaskRunnerOverride, parseDotPathRunnerOverride, serializeTaskRunnerOverride } from "../task-runner-override.js";

describe("normalizeTaskRunnerOverride", () => {
  test("returns null for empty input", () => {
    expect(normalizeTaskRunnerOverride(null)).toBeNull();
    expect(normalizeTaskRunnerOverride(undefined)).toBeNull();
    expect(normalizeTaskRunnerOverride({})).toBeNull();
  });

  test("normalizes nested execution and reviewer overrides", () => {
    expect(
      normalizeTaskRunnerOverride({
        execution: { model: "gpt-5.5", effort: "xhigh" },
        reviewer: { model: "claude-opus-4-7", effort: "max" },
      }),
    ).toEqual({
      execution: { model: "gpt-5.5", effort: "xhigh" },
      reviewer: { model: "claude-opus-4-7", effort: "max" },
    });
  });

  test("expands shorthand into execution", () => {
    expect(normalizeTaskRunnerOverride({ model: "gpt-5.5", effort: "xhigh" })).toEqual({
      execution: { model: "gpt-5.5", effort: "xhigh" },
    });
  });

  test("merges shorthand with explicit execution override", () => {
    expect(
      normalizeTaskRunnerOverride({
        execution: { effort: "high" },
        model: "gpt-5.5",
      }),
    ).toEqual({
      execution: { effort: "high", model: "gpt-5.5" },
    });
  });

  test("ignores blank string fields", () => {
    expect(normalizeTaskRunnerOverride({ execution: { model: "  ", effort: "high" } })).toEqual({
      execution: { effort: "high" },
    });
  });
});

describe("parseDotPathRunnerOverride", () => {
  test("returns null when no runner keys are present", () => {
    expect(parseDotPathRunnerOverride(new Map([["repos", "foreman"]]))).toBeNull();
  });

  test("parses Runner.execution.* and Runner.reviewer.* keys", () => {
    const entries = new Map([
      ["repos", "foreman"],
      ["runner.execution.model", "gpt-5.5"],
      ["runner.execution.effort", "xhigh"],
      ["runner.reviewer.model", "claude-opus-4-7"],
      ["runner.reviewer.effort", "max"],
    ]);

    expect(parseDotPathRunnerOverride(entries)).toEqual({
      execution: { model: "gpt-5.5", effort: "xhigh" },
      reviewer: { model: "claude-opus-4-7", effort: "max" },
    });
  });

  test("expands shorthand Runner.* keys into execution override", () => {
    const entries = new Map([
      ["runner.model", "gpt-5.5"],
      ["runner.effort", "xhigh"],
    ]);

    expect(parseDotPathRunnerOverride(entries)).toEqual({
      execution: { model: "gpt-5.5", effort: "xhigh" },
    });
  });

  test("ignores unknown role and field names", () => {
    const entries = new Map([
      ["runner.bogus.model", "gpt-5.5"],
      ["runner.execution.unknown", "value"],
    ]);

    expect(parseDotPathRunnerOverride(entries)).toBeNull();
  });
});

describe("serializeTaskRunnerOverride", () => {
  test("returns null for null or empty overrides", () => {
    expect(serializeTaskRunnerOverride(null)).toBeNull();
    expect(serializeTaskRunnerOverride(undefined)).toBeNull();
    expect(serializeTaskRunnerOverride({})).toBeNull();
  });

  test("serializes nested overrides into a plain object", () => {
    expect(
      serializeTaskRunnerOverride({
        execution: { model: "gpt-5.5", effort: "xhigh" },
        reviewer: { model: "claude-opus-4-7" },
      }),
    ).toEqual({
      execution: { model: "gpt-5.5", effort: "xhigh" },
      reviewer: { model: "claude-opus-4-7" },
    });
  });
});
