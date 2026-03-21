import { afterEach, describe, expect, test, vi } from "vitest";

import { createDefaultWorkspaceConfig } from "../../../workspace/config.js";
import { LinearTaskSystem, parseLinearMetadata } from "../../index.js";

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
  runnerLine() {},
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

  test("skips unmapped provider states and logs the skipped issue", async () => {
    const logger = {
      child() {
        return this;
      },
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      line: vi.fn(),
      runnerLine: vi.fn(),
      flush: async () => undefined,
    };

    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };

      if (body.query.includes("query ForemanViewer")) {
        return new Response(JSON.stringify({ data: { viewer: { id: "user-123", name: "Test User" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (body.query.includes("query ForemanIssueCandidates")) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  linearIssue([], "Test User").issues.nodes[0],
                  {
                    id: "issue-2",
                    identifier: "ENG-124",
                    title: "Skipped task",
                    description: "Agent:\n  Repo: repo-a\n",
                    branchName: "eng-124",
                    updatedAt: "2026-03-14T12:01:00Z",
                    url: "https://linear.app/acme/issue/ENG-124/task",
                    priorityLabel: "normal",
                    state: { id: "state-2", name: "Blocked" },
                    assignee: { name: "Test User" },
                    labels: { nodes: [{ id: "label-1", name: "Agent" }] },
                    attachments: { nodes: [] },
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

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, logger as any);
    const tasks = await taskSystem.listCandidates();

    expect(tasks.map((task) => task.id)).toEqual(["ENG-123"]);
    expect(logger.info).toHaveBeenCalledWith("skipping Linear candidate with unmapped provider state", {
      provider: "linear",
      taskId: "ENG-124",
      providerId: "issue-2",
      providerState: "Blocked",
    });
  });
});

describe("parseLinearMetadata", () => {
  test("parses Agent metadata blocks", () => {
    expect(parseLinearMetadata("Agent:\n  Repo: repo-a\n  Depends on tasks: ENG-123\n  Branch: eng-124\n")).toEqual({
      targets: [{ repoKey: "repo-a", branchName: "eng-124", position: 0 }],
      targetDependencies: [],
      dependencies: {
        taskIds: ["ENG-123"],
        baseTaskId: null,
      },
    });
  });

  test("rejects deprecated branch dependency metadata", () => {
    expect(() => parseLinearMetadata("Agent:\n  Repo: repo-a\n  Depends on branches: eng-123\n")).toThrow(
      "Depends on branches is no longer supported",
    );
  });

  test("normalizes Markdown-linked task dependencies", () => {
    expect(
      parseLinearMetadata(
        "Agent:\n  Repo: repo-a\n  Depends on tasks: [ENG-123](https://linear.app/acme/issue/ENG-123/task), ENG-124\n  Base from task: [ENG-123](https://linear.app/acme/issue/ENG-123/task)\n",
      ),
    ).toEqual({
      targets: [],
      targetDependencies: [],
      dependencies: {
        taskIds: ["ENG-123", "ENG-124"],
        baseTaskId: "ENG-123",
      },
    });
  });

  test("falls back to extracting task ids from Markdown link targets", () => {
    expect(
      parseLinearMetadata(
        "Agent:\n  Repo: repo-a\n  Depends on tasks: [target migration](https://linear.app/acme/issue/ENG-4773/normalize-jobs-review-state-and-task-apis-around-task-targets)\n  Base from task: [base task](https://linear.app/acme/issue/ENG-4772/persist-task-and-target-mirrors-for-lynk-tasks)\n",
      ),
    ).toEqual({
      targets: [],
      targetDependencies: [],
      dependencies: {
        taskIds: ["ENG-4773"],
        baseTaskId: "ENG-4772",
      },
    });
  });

  test("parses multi-target repo metadata and explicit repo dependencies", () => {
    expect(
      parseLinearMetadata(
        "Agent:\n  Repos: common, lynk-frontend, web-front-door\n  Repo dependencies: lynk-frontend<-common, web-front-door<-common\n  Branch: eng-4774\n",
      ),
    ).toEqual({
      targets: [
        { repoKey: "common", branchName: "eng-4774", position: 0 },
        { repoKey: "lynk-frontend", branchName: "eng-4774", position: 1 },
        { repoKey: "web-front-door", branchName: "eng-4774", position: 2 },
      ],
      targetDependencies: [
        { taskTargetRepoKey: "lynk-frontend", dependsOnRepoKey: "common", position: 0 },
        { taskTargetRepoKey: "web-front-door", dependsOnRepoKey: "common", position: 1 },
      ],
      dependencies: {
        taskIds: [],
        baseTaskId: null,
      },
    });
  });

  test("hydrates multi-target Linear tasks with targets and repo dependencies", async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };

      if (body.query.includes("query ForemanIssue")) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    ...linearIssue([], "Test User").issues.nodes[0],
                    description:
                      "Agent:\n  Repos: common, lynk-frontend\n  Repo dependencies: lynk-frontend<-common\n  Branch: eng-4774\n",
                    branchName: "eng-4774",
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

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, fakeLogger as any);
    const task = await taskSystem.getTask("ENG-123");

    expect(task.targets).toEqual([
      { repoKey: "common", branchName: "eng-4774", position: 0 },
      { repoKey: "lynk-frontend", branchName: "eng-4774", position: 1 },
    ]);
    expect(task.targetDependencies).toEqual([
      { taskTargetRepoKey: "lynk-frontend", dependsOnRepoKey: "common", position: 0 },
    ]);
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

  test("ignores non-GitHub attachments when hydrating task artifacts", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanIssue")) {
        return new Response(
          JSON.stringify({
            data: linearIssue([
              { id: "att-pr", title: "PR 1", url: "https://github.com/acme/repo-a/pull/1" },
              { id: "att-doc", title: "Design doc", url: "https://docs.example.com/spec" },
            ]),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, fakeLogger as any);
    const task = await taskSystem.getTask("ENG-123");

    expect(task.artifacts).toEqual([
      {
        type: "pull_request",
        url: "https://github.com/acme/repo-a/pull/1",
        title: "PR 1",
        externalId: "att-pr",
      },
    ]);
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
  test("skips pull request artifacts because Linear auto-links them", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);
      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, fakeLogger as any);
    await taskSystem.addArtifact({
      taskId: "ENG-123",
      artifact: {
        type: "pull_request",
        url: "https://github.com/acme/repo-a/pull/1",
        title: "PR 1",
      },
    });

    expect(requests).toHaveLength(0);
  });

  test("does not create Linear attachments for non-GitHub pull request URLs", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);
      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, fakeLogger as any);
    await taskSystem.addArtifact({
      taskId: "ENG-123",
      artifact: {
        type: "pull_request",
        url: "https://example.com/pull/1",
        title: "PR 1",
      },
    });

    expect(requests).toHaveLength(0);
  });
});
