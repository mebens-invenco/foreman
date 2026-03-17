import { describe, expect, test } from "vitest";

import { createDefaultWorkspaceConfig, parseWorkspaceConfig, stringifyWorkspaceConfig } from "../src/workspace/config.js";

describe("workspace config", () => {
  test("round-trips default file task config", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    const parsed = parseWorkspaceConfig(stringifyWorkspaceConfig(config));

    expect(parsed.workspace.name).toBe("foo");
    expect(parsed.taskSystem.type).toBe("file");
    expect(parsed.scheduler.workerConcurrency).toBe(4);
    expect(parsed.http.port).toBe(8765);
  });

  test("rejects mismatched task system blocks", () => {
    expect(() =>
      parseWorkspaceConfig(`
version: 1
workspace:
  name: foo
  agentPrefix: "[agent] "
repos:
  explicit: []
  roots: []
  ignore: []
taskSystem:
  type: linear
reviewSystem:
  type: github
runner:
  type: opencode
  model: openai/gpt-5.4
  variant: high
  timeoutMs: 3600000
scheduler:
  workerConcurrency: 4
  scoutPollIntervalSeconds: 60
  scoutRerunDebounceMs: 1000
  leaseTtlSeconds: 120
  workerHeartbeatSeconds: 15
  staleLeaseReapIntervalSeconds: 15
  schedulerLoopIntervalMs: 1000
  shutdownGracePeriodSeconds: 10
http:
  host: 127.0.0.1
  port: 8765
`),
    ).toThrow(/taskSystem\.linear/);
  });
});
