import { describe, expect, test } from "vitest";

import { formatGitHubAgentComment, isGitHubAgentComment } from "../github-comment-badge.js";

describe("GitHub agent comment badges", () => {
  test("renders an OpenAI model badge with normalized label and accessible provenance", () => {
    const body = formatGitHubAgentComment("[agent] Addressed in latest head", {
      label: "[agent] ",
      runnerName: "opencode",
      runnerModel: "openai/gpt-5.6-sol",
    });

    expect(body).toBe(
      "![agent | opencode | openai/gpt-5.6-sol](https://img.shields.io/badge/sol-agent-555?logo=opencode&logoColor=white&labelColor=1A1A1A)\n\nAddressed in latest head",
    );
    expect(isGitHubAgentComment(body, "[agent] ")).toBe(true);
    expect(isGitHubAgentComment(body, "[review agent] ")).toBe(false);
  });

  test("renders Claude family names and does not duplicate an existing badge", () => {
    const attribution = {
      label: "[review agent] ",
      runnerName: "claude" as const,
      runnerModel: "claude-fable-5",
    };
    const body = formatGitHubAgentComment("Review complete", attribution);

    expect(body).toBe(
      "![review agent | claude | claude-fable-5](https://img.shields.io/badge/fable-review_agent-555?logo=claude&logoColor=white&labelColor=D97757)\n\nReview complete",
    );
    expect(formatGitHubAgentComment(body, attribution)).toBe(body);
  });

  test("encodes custom labels and falls back to the provider-stripped model", () => {
    const body = formatGitHubAgentComment("Done", {
      label: "[review_agent-v2] ",
      runnerName: "opencode",
      runnerModel: "google/gemini-2.5-pro",
    });

    expect(body).toBe(
      "![review_agent-v2 | opencode | google/gemini-2.5-pro](https://img.shields.io/badge/gemini--2.5--pro-review__agent--v2-555?logo=opencode&logoColor=white&labelColor=1A1A1A)\n\nDone",
    );
  });

  test("does not show a misleading provider logo for Codex", () => {
    const body = formatGitHubAgentComment("Done", {
      label: "[agent] ",
      runnerName: "codex",
      runnerModel: "gpt-5.6-sol",
    });

    expect(body).toBe("![agent | codex | gpt-5.6-sol](https://img.shields.io/badge/sol-agent-555)\n\nDone");
  });
});
