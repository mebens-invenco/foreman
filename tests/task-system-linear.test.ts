import { afterEach, describe, expect, test, vi } from "vitest";

import { createDefaultWorkspaceConfig } from "../src/config.js";
import { LinearTaskSystem, parseLinearMetadata } from "../src/task-system.js";

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

const linearIssue = (
  attachments: Array<{ id: string; title: string | null; url: string }>,
  assigneeName = "Test User",
) => ({
  issues: {
    nodes: [
      {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Task",
        description: "Agent:\n  Repo: repo-a\n",
        branchName: "eng-123",
        updatedAt: "2026-03-14T12:00:00Z",
        url: "https://linear.app/acme/issue/ENG-123/task",
        priorityLabel: "high",
        state: { id: "state-1", name: "Todo" },
        assignee: { name: assigneeName },
        labels: { nodes: [{ id: "label-1", name: "Agent" }] },
        attachments: { nodes: attachments },
      },
    ],
  },
});

describe("LinearTaskSystem.listCandidates", () => {
  test("resolves assignee 'me' from the authenticated Linear user", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanViewer")) {
        return new Response(JSON.stringify({ data: { viewer: { id: "user-123", name: "Test User" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (body.query.includes("query ForemanIssueCandidates")) {
        return new Response(JSON.stringify({ data: linearIssue([], "Test User") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, fakeLogger as any);
    const tasks = await taskSystem.listCandidates();

    expect(tasks).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query).toContain("query ForemanViewer");
    expect(requests[1]?.query).toContain("$assigneeId: ID!");
    expect(requests[1]?.query).toContain("assignee: { id: { eq: $assigneeId } }");
    expect(requests[1]?.variables).toEqual({
      teamName: "Engineering",
      labels: ["Agent"],
      assigneeId: "user-123",
    });
  });

  test("uses the configured assignee name directly when it is explicit", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanIssueCandidates")) {
        return new Response(JSON.stringify({ data: linearIssue([], "Jane Doe") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.assignee = "Jane Doe";
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, fakeLogger as any);
    const tasks = await taskSystem.listCandidates();

    expect(tasks).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).not.toContain("query ForemanViewer");
    expect(requests[0]?.query).toContain("assignee: { name: { eq: $assigneeName } }");
    expect(requests[0]?.variables).toEqual({
      teamName: "Engineering",
      labels: ["Agent"],
      assigneeName: "Jane Doe",
    });
  });
});

describe("parseLinearMetadata", () => {
  test("parses Agent metadata blocks", () => {
    expect(
      parseLinearMetadata("Agent:\n  Repo: repo-a\n  Depends on tasks: ENG-123\n  Depends on branches: eng-123\n  Branch: eng-124\n"),
    ).toEqual({
      repo: "repo-a",
      branchName: "eng-124",
      dependencies: {
        taskIds: ["ENG-123"],
        baseTaskId: null,
        branchNames: ["eng-123"],
      },
    });
  });

  test("ignores legacy Foreman metadata blocks", () => {
    expect(parseLinearMetadata("Foreman:\n  Repo: repo-a\n  Depends on tasks: ENG-123\n")).toEqual({
      repo: null,
      branchName: null,
      dependencies: {
        taskIds: [],
        baseTaskId: null,
        branchNames: [],
      },
    });
  });
});

describe("LinearTaskSystem.getTask", () => {
  test("looks up identifier-style task ids by team key and number", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanIssue")) {
        return new Response(JSON.stringify({ data: linearIssue([], "Test User") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, fakeLogger as any);
    const task = await taskSystem.getTask("ENG-123");

    expect(task.id).toBe("ENG-123");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toContain("team: { key: { eq: $teamKey } }");
    expect(requests[0]?.query).toContain("number: { eq: $number }");
    expect(requests[0]?.variables).toEqual({ teamKey: "ENG", number: 123 });
  });
});

describe("LinearTaskSystem.transition", () => {
  test("uses the configured team's workflow state when state names overlap across teams", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanIssue")) {
        return new Response(JSON.stringify({ data: linearIssue([], "Test User") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (body.query.includes("query ForemanTeamInfo")) {
        return new Response(
          JSON.stringify({
            data: {
              teams: {
                nodes: [
                  {
                    id: "team-engineering",
                    name: "Engineering",
                    states: {
                      nodes: [
                        { id: "state-todo", name: "Todo" },
                        { id: "state-in-progress-engineering", name: "In Progress" },
                      ],
                    },
                  },
                ],
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (body.query.includes("mutation ForemanIssueUpdate")) {
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, fakeLogger as any);
    await taskSystem.transition({ taskId: "ENG-123", toState: "in_progress" });

    expect(requests).toHaveLength(3);
    expect(requests[1]?.query).toContain("query ForemanTeamInfo");
    expect(requests[1]?.query).not.toContain("workflowStates");
    expect(requests[1]?.variables).toEqual({ teamName: "Engineering" });
    expect(requests[2]?.query).toContain("mutation ForemanIssueUpdate");
    expect(requests[2]?.variables).toEqual({
      id: "issue-1",
      stateId: "state-in-progress-engineering",
    });
  });
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
