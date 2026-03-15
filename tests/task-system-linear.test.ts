import { afterEach, describe, expect, test, vi } from "vitest";

import { createDefaultWorkspaceConfig } from "../src/config.js";
import { LinearTaskSystem } from "../src/task-system.js";

const originalFetch = global.fetch;
const fakeLogger = {
  child() {
    return this;
  },
  debug() {},
  info() {},
  warn() {},
  error() {},
  line() {},
  flush: async () => undefined,
};

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const linearIssue = (attachments: Array<{ id: string; title: string | null; url: string }>) => ({
  issues: {
    nodes: [
      {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Task",
        description: "Foreman:\n  Repo: repo-a\n",
        branchName: "eng-123",
        updatedAt: "2026-03-14T12:00:00Z",
        url: "https://linear.app/acme/issue/ENG-123/task",
        priorityLabel: "high",
        state: { id: "state-1", name: "Todo" },
        assignee: { name: "me" },
        labels: { nodes: [{ id: "label-1", name: "Agent" }] },
        attachments: { nodes: attachments },
      },
    ],
  },
});

describe("LinearTaskSystem.addArtifact", () => {
  test("updates matching artifacts instead of creating duplicates", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanIssue")) {
        return new Response(
          JSON.stringify({
            data: linearIssue([{ id: "att-1", title: "Old title", url: "https://github.com/acme/repo-a/pull/1" }]),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (body.query.includes("mutation ForemanAttachmentUpdate")) {
        return new Response(JSON.stringify({ data: { attachmentUpdate: { success: true } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, fakeLogger as any);
    await taskSystem.addArtifact({
      taskId: "ENG-123",
      artifact: {
        type: "pull_request",
        url: "https://github.com/acme/repo-a/pull/1",
        title: "New title",
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.query).toContain("mutation ForemanAttachmentUpdate");
    expect(requests[1]?.variables).toEqual({ id: "att-1", title: "New title" });
  });

  test("creates artifacts when no existing match is found", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanIssue")) {
        return new Response(JSON.stringify({ data: linearIssue([]) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (body.query.includes("mutation ForemanAttachmentCreate")) {
        return new Response(JSON.stringify({ data: { attachmentCreate: { success: true } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, fakeLogger as any);
    await taskSystem.addArtifact({
      taskId: "ENG-123",
      artifact: {
        type: "pull_request",
        url: "https://github.com/acme/repo-a/pull/2",
        title: "PR 2",
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.query).toContain("mutation ForemanAttachmentCreate");
    expect(requests[1]?.variables).toEqual({
      issueId: "issue-1",
      url: "https://github.com/acme/repo-a/pull/2",
      title: "PR 2",
    });
  });
});
