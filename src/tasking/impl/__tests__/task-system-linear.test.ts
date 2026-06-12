import { afterEach, describe, expect, test, vi } from "vitest";

import { ForemanError, isForemanError } from "../../../lib/errors.js";
import { createDefaultWorkspaceConfig } from "../../../workspace/config.js";
import { LinearClient, LinearTaskSystem, linearPriorityToNormalized, normalizedPriorityToLinear, parseLinearMetadata } from "../../index.js";

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

const createSpyingLogger = () => ({
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
});

const timeoutError = (): Error => Object.assign(new Error("Timed out"), { name: "TimeoutError" });

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
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

const DEFAULT_LINEAR_STATE_NAMES = ["Todo", "Ready", "In Progress", "In Review", "Ready to Deploy", "Done", "Canceled"];

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

      if (body.query.includes("query ForemanAssignedIssues")) {
        return new Response(JSON.stringify({ data: linearIssue([], "Test User") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    const tasks = await taskSystem.listCandidates();

    expect(tasks).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query).toContain("query ForemanViewer");
    expect(requests[1]?.query).toContain("$assigneeId: ID!");
    expect(requests[1]?.query).toContain("$stateNames: [String!]");
    expect(requests[1]?.query).toContain("assignee: { id: { eq: $assigneeId } }");
    expect(requests[1]?.query).toContain("state: { name: { in: $stateNames } }");
    expect(requests[1]?.variables).toEqual({
      teamName: "Engineering",
      labels: ["Agent"],
      assigneeId: "user-123",
      stateNames: DEFAULT_LINEAR_STATE_NAMES,
    });
  });

  test("uses the configured assignee name directly when it is explicit", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanAssignedIssues")) {
        return new Response(JSON.stringify({ data: linearIssue([], "Jane Doe") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.assignee = "Jane Doe";
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    const tasks = await taskSystem.listCandidates();

    expect(tasks).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).not.toContain("query ForemanViewer");
    expect(requests[0]?.query).toContain("$stateNames: [String!]");
    expect(requests[0]?.query).toContain("assignee: { name: { eq: $assigneeName } }");
    expect(requests[0]?.query).toContain("state: { name: { in: $stateNames } }");
    expect(requests[0]?.variables).toEqual({
      teamName: "Engineering",
      labels: ["Agent"],
      assigneeName: "Jane Doe",
      stateNames: DEFAULT_LINEAR_STATE_NAMES,
    });
  });

  test("retries a transient candidate query timeout and returns candidates", async () => {
    vi.useFakeTimers();
    const logger = createSpyingLogger();
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: linearIssue([], "Jane Doe") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as typeof fetch;

    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.assignee = "Jane Doe";
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], logger as any);

    const tasksPromise = taskSystem.listCandidates();
    await vi.advanceTimersByTimeAsync(250);
    const tasks = await tasksPromise;

    expect(tasks.map((task) => task.id)).toEqual(["ENG-123"]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "Linear GraphQL request timed out; retrying",
      expect.objectContaining({
        operationName: "ForemanAssignedIssues",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 250,
        timeoutMs: 60_000,
      }),
    );
  });

  test("retries a transient candidate query status and returns candidates", async () => {
    vi.useFakeTimers();
    const logger = createSpyingLogger();
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: linearIssue([], "Jane Doe") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as typeof fetch;

    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.assignee = "Jane Doe";
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], logger as any);

    const tasksPromise = taskSystem.listCandidates();
    await vi.advanceTimersByTimeAsync(250);
    const tasks = await tasksPromise;

    expect(tasks.map((task) => task.id)).toEqual(["ENG-123"]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "Linear GraphQL request failed with transient status; retrying",
      expect.objectContaining({
        operationName: "ForemanAssignedIssues",
        status: 503,
        attempt: 1,
        maxAttempts: 3,
        delayMs: 250,
      }),
    );
  });

  test("does not retry non-transient candidate query statuses", async () => {
    const logger = createSpyingLogger();
    global.fetch = vi.fn(async () => new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" })) as typeof fetch;

    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.assignee = "Jane Doe";
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], logger as any);

    await expect(taskSystem.listCandidates()).rejects.toThrow("Linear request failed: 500 Internal Server Error");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("surfaces candidate query transient status after bounded retries", async () => {
    vi.useFakeTimers();
    const logger = createSpyingLogger();
    global.fetch = vi.fn(async () => new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" })) as typeof fetch;

    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.assignee = "Jane Doe";
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], logger as any);

    const tasksPromise = taskSystem.listCandidates();
    const expectation = expect(tasksPromise).rejects.toMatchObject({ code: "linear_request_failed" });
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      "Linear GraphQL request failed",
      expect.objectContaining({
        operationName: "ForemanAssignedIssues",
        status: 503,
        attempt: 3,
        maxAttempts: 3,
      }),
    );
  });

  test("surfaces candidate query timeout after bounded retries", async () => {
    vi.useFakeTimers();
    const logger = createSpyingLogger();
    global.fetch = vi.fn().mockRejectedValue(timeoutError()) as typeof fetch;

    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.assignee = "Jane Doe";
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], logger as any);

    const tasksPromise = taskSystem.listCandidates();
    const expectation = expect(tasksPromise).rejects.toMatchObject({ code: "linear_request_timeout" });
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      "Linear GraphQL request timed out; retrying",
      expect.objectContaining({
        operationName: "ForemanAssignedIssues",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1_000,
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "Linear GraphQL request timed out",
      expect.objectContaining({
        operationName: "ForemanAssignedIssues",
        attempt: 3,
        maxAttempts: 3,
        timeoutMs: 60_000,
      }),
    );
  });

  test("does not retry GraphQL errors from candidate queries", async () => {
    const logger = createSpyingLogger();
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: "Cannot query field \"bad\"" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof fetch;

    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.assignee = "Jane Doe";
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], logger as any);

    await expect(taskSystem.listCandidates()).rejects.toThrow('Cannot query field "bad"');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("does not retry mutations when transient retries are requested", async () => {
    const logger = createSpyingLogger();
    global.fetch = vi.fn().mockRejectedValue(timeoutError()) as typeof fetch;
    const client = new LinearClient("test-key", logger as any);

    await expect(
      client.request(
        `mutation ForemanMutation {
          issueUpdate(id: "issue-1", input: { title: "Task" }) { success }
        }`,
        {},
        { retryTransient: true },
      ),
    ).rejects.toMatchObject({ code: "linear_request_timeout" });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("does not retry mutation transient statuses when transient retries are requested", async () => {
    const logger = createSpyingLogger();
    global.fetch = vi.fn(async () => new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" })) as typeof fetch;
    const client = new LinearClient("test-key", logger as any);

    await expect(
      client.request(
        `mutation ForemanMutation {
          issueUpdate(id: "issue-1", input: { title: "Task" }) { success }
        }`,
        {},
        { retryTransient: true },
      ),
    ).rejects.toMatchObject({ code: "linear_request_failed" });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("uses unique configured states from every Linear state mapping in candidate queries", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanAssignedIssues")) {
        return new Response(JSON.stringify({ data: linearIssue([], "Jane Doe") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.assignee = "Jane Doe";
    config.taskSystem.linear!.states = {
      ready: ["Ready", "Queued"],
      inProgress: ["Started", "Queued"],
      inReview: ["Reviewing", "Queued"],
      deployable: ["Deployable"],
      done: ["Done"],
      canceled: ["Canceled", "Queued"],
    };
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);

    await taskSystem.listCandidates();

    expect(requests[0]?.variables.stateNames).toEqual(["Ready", "Queued", "Started", "Reviewing", "Deployable", "Done", "Canceled"]);
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

      if (body.query.includes("query ForemanAssignedIssues")) {
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
                    priorityLabel: "Medium",
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

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], logger as any);
    const tasks = await taskSystem.listCandidates();

    expect(tasks.map((task) => task.id)).toEqual(["ENG-123"]);
    expect(requests[1]?.variables).toMatchObject({ stateNames: DEFAULT_LINEAR_STATE_NAMES });
    expect(logger.info).toHaveBeenCalledWith("skipping Linear issue with unmapped provider state", {
      provider: "linear",
      taskId: "ENG-124",
      providerId: "issue-2",
      providerState: "Blocked",
    });
  });
});

describe("LinearTaskSystem.listAssignedIssues", () => {
  test("omits the label filter and variable on the assigneeId path", async () => {
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

      if (body.query.includes("query ForemanAssignedIssues")) {
        return new Response(JSON.stringify({ data: linearIssue([], "Test User") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    const tasks = await taskSystem.listAssignedIssues();

    expect(tasks).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.query).toContain("$assigneeId: ID!");
    expect(requests[1]?.query).toContain("assignee: { id: { eq: $assigneeId } }");
    // The no-label branch must drop both the $labels var-decl and the filter
    // clause, so a malformed assembly (dangling comma / stray $labels) is caught.
    expect(requests[1]?.query).not.toContain("$labels: [String!]");
    expect(requests[1]?.query).not.toContain("labels: { some: { name: { in: $labels } } }");
    expect(requests[1]?.query).not.toContain("$stateNames: [String!]");
    expect(requests[1]?.query).not.toContain("state: { name: { in: $stateNames } }");
    // ...and send no labels variable at all.
    expect(requests[1]?.variables).toEqual({
      teamName: "Engineering",
      assigneeId: "user-123",
    });
  });

  test("omits the label filter and variable on the assigneeName path", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanAssignedIssues")) {
        return new Response(JSON.stringify({ data: linearIssue([], "Jane Doe") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.assignee = "Jane Doe";
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    const tasks = await taskSystem.listAssignedIssues();

    expect(tasks).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).not.toContain("query ForemanViewer");
    expect(requests[0]?.query).toContain("assignee: { name: { eq: $assigneeName } }");
    expect(requests[0]?.query).not.toContain("$labels: [String!]");
    expect(requests[0]?.query).not.toContain("labels: { some: { name: { in: $labels } } }");
    expect(requests[0]?.query).not.toContain("$stateNames: [String!]");
    expect(requests[0]?.query).not.toContain("state: { name: { in: $stateNames } }");
    expect(requests[0]?.variables).toEqual({
      teamName: "Engineering",
      assigneeName: "Jane Doe",
    });
  });

  test("retries transient assigned-issues query statuses without adding label variables", async () => {
    vi.useFakeTimers();
    const logger = createSpyingLogger();
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi
      .fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
        requests.push(body);

        if (!body.query.includes("query ForemanAssignedIssues")) {
          throw new Error(`Unexpected query: ${body.query}`);
        }

        if (requests.length === 1) {
          return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
        }

        return new Response(JSON.stringify({ data: linearIssue([], "Jane Doe") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.assignee = "Jane Doe";
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], logger as any);

    const tasksPromise = taskSystem.listAssignedIssues();
    await vi.advanceTimersByTimeAsync(250);
    const tasks = await tasksPromise;

    expect(tasks.map((task) => task.id)).toEqual(["ENG-123"]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(requests[1]?.query).not.toContain("$labels: [String!]");
    expect(requests[1]?.variables).toEqual({
      teamName: "Engineering",
      assigneeName: "Jane Doe",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Linear GraphQL request failed with transient status; retrying",
      expect.objectContaining({
        operationName: "ForemanAssignedIssues",
        status: 503,
        attempt: 1,
        maxAttempts: 3,
        delayMs: 250,
      }),
    );
  });
});

describe("LinearTaskSystem.validateStartup", () => {
  const ALL_TEAM_STATES = ["Todo", "Ready", "In Progress", "In Review", "Ready to Deploy", "Done", "Canceled"];
  const ALL_LABELS = ["Agent", "Agent Created", "Agent Consolidated"];

  const jsonResponse = (data: unknown) =>
    new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });

  const stubStartupFetch = (options: { teamName?: string; teamStates: string[]; labels: string[] }) => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };

      if (body.query.includes("query ForemanTeamInfo")) {
        return jsonResponse({
          teams: {
            nodes: [
              {
                id: "team-engineering",
                name: options.teamName ?? "Engineering",
                states: { nodes: options.teamStates.map((name, index) => ({ id: `state-${index}`, name })) },
              },
            ],
          },
        });
      }

      if (body.query.includes("query ValidateForemanStartup")) {
        return jsonResponse({ issueLabels: { nodes: options.labels.map((name, index) => ({ id: `label-${index}`, name })) } });
      }

      if (body.query.includes("query ForemanViewer")) {
        return jsonResponse({ viewer: { id: "user-123", name: "Test User" } });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;
  };

  const expectForemanError = async (run: Promise<unknown>, code: string): Promise<ForemanError> => {
    const error = await run.then(
      () => null,
      (caught) => caught,
    );
    expect(isForemanError(error)).toBe(true);
    const foremanError = error as ForemanError;
    expect(foremanError.code).toBe(code);
    return foremanError;
  };

  test("resolves when every configured label and state exists in Linear", async () => {
    stubStartupFetch({ teamStates: ALL_TEAM_STATES, labels: ALL_LABELS });
    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    await expect(taskSystem.validateStartup()).resolves.toBeUndefined();
  });

  test("throws linear_label_not_found naming a configured label missing from Linear", async () => {
    stubStartupFetch({ teamStates: ALL_TEAM_STATES, labels: ["Agent Created", "Agent Consolidated"] });
    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    const error = await expectForemanError(taskSystem.validateStartup(), "linear_label_not_found");
    expect(error.message).toContain("Agent");
  });

  test("treats a case-mismatched label as missing (strict match, not case-insensitive)", async () => {
    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.includeLabels = ["Agent:Tars"];
    stubStartupFetch({ teamStates: ALL_TEAM_STATES, labels: ["agent:tars", "Agent Created", "Agent Consolidated"] });
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    const error = await expectForemanError(taskSystem.validateStartup(), "linear_label_not_found");
    expect(error.message).toContain("Agent:Tars");
  });

  test("names every missing label when several configured labels are absent", async () => {
    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.includeLabels = ["Agent", "Backend", "Frontend"];
    stubStartupFetch({ teamStates: ALL_TEAM_STATES, labels: ["Agent", "Agent Created", "Agent Consolidated"] });
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    const error = await expectForemanError(taskSystem.validateStartup(), "linear_label_not_found");
    expect(error.message).toContain("Backend");
    expect(error.message).toContain("Frontend");
  });

  test("throws linear_label_not_found when a configured exclude label is missing from Linear", async () => {
    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.excludeLabels = ["agent:disabled"];
    stubStartupFetch({ teamStates: ALL_TEAM_STATES, labels: ALL_LABELS });
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    const error = await expectForemanError(taskSystem.validateStartup(), "linear_label_not_found");
    expect(error.message).toContain("agent:disabled");
  });

  test("resolves when configured exclude labels exist in Linear", async () => {
    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.excludeLabels = ["agent:disabled"];
    stubStartupFetch({ teamStates: ALL_TEAM_STATES, labels: [...ALL_LABELS, "agent:disabled"] });
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    await expect(taskSystem.validateStartup()).resolves.toBeUndefined();
  });

  test("throws linear_state_not_found naming a configured state missing from the team", async () => {
    stubStartupFetch({ teamStates: ALL_TEAM_STATES.filter((state) => state !== "Ready to Deploy"), labels: ALL_LABELS });
    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    const error = await expectForemanError(taskSystem.validateStartup(), "linear_state_not_found");
    expect(error.message).toContain("Ready to Deploy");
  });

  test("treats a case-mismatched state as missing (strict match, not case-insensitive)", async () => {
    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.states.ready = ["todo"];
    stubStartupFetch({ teamStates: ALL_TEAM_STATES, labels: ALL_LABELS });
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    const error = await expectForemanError(taskSystem.validateStartup(), "linear_state_not_found");
    expect(error.message).toContain("todo");
  });

  test("names every missing state when several configured states are absent", async () => {
    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.states.ready = ["Backlog"];
    config.taskSystem.linear!.states.deployable = ["Shippable"];
    stubStartupFetch({ teamStates: ALL_TEAM_STATES, labels: ALL_LABELS });
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    const error = await expectForemanError(taskSystem.validateStartup(), "linear_state_not_found");
    expect(error.message).toContain("Backlog");
    expect(error.message).toContain("Shippable");
  });

  test("preserves linear_team_not_found when the configured team does not resolve", async () => {
    stubStartupFetch({ teamName: "Different Team", teamStates: ALL_TEAM_STATES, labels: ALL_LABELS });
    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    await expectForemanError(taskSystem.validateStartup(), "linear_team_not_found");
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
      baseBranch: null,
      runnerOverride: null,
    });
  });

  test("parses explicit base branch metadata", () => {
    expect(parseLinearMetadata("Agent:\n  Repo: repo-a\n  Base branch: release/2026-05\n")).toEqual({
      targets: [],
      targetDependencies: [],
      dependencies: {
        taskIds: [],
        baseTaskId: null,
      },
      baseBranch: "release/2026-05",
      runnerOverride: null,
    });
  });

  test("parses nested Runner.execution and Runner.reviewer dot-path keys", () => {
    expect(
      parseLinearMetadata(
        "Agent:\n  Repos: foreman\n  Runner.execution.model: gpt-5.5\n  Runner.execution.tuning: xhigh\n  Runner.reviewer.model: claude-opus-4-7\n  Runner.reviewer.tuning: max\n",
      ).runnerOverride,
    ).toEqual({
      execution: { model: "gpt-5.5", tuning: "xhigh" },
      reviewer: { model: "claude-opus-4-7", tuning: "max" },
    });
  });

  test("parses shorthand Runner.model and Runner.tuning into the execution override", () => {
    expect(
      parseLinearMetadata("Agent:\n  Repos: foreman\n  Runner.model: gpt-5.5\n  Runner.tuning: xhigh\n").runnerOverride,
    ).toEqual({
      execution: { model: "gpt-5.5", tuning: "xhigh" },
    });
  });

  test("normalizes runner dot-path keys case-insensitively", () => {
    expect(
      parseLinearMetadata("Agent:\n  Repos: foreman\n  RUNNER.EXECUTION.MODEL: gpt-5.5\n").runnerOverride,
    ).toEqual({ execution: { model: "gpt-5.5" } });
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
      baseBranch: null,
      runnerOverride: null,
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
      baseBranch: null,
      runnerOverride: null,
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
      baseBranch: null,
      runnerOverride: null,
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

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
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

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    const task = await taskSystem.getTask("ENG-123");

    expect(task.id).toBe("ENG-123");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toContain("team: { key: { eq: $teamKey } }");
    expect(requests[0]?.query).toContain("number: { eq: $number }");
    expect(requests[0]?.variables).toEqual({ teamKey: "ENG", number: 123 });
  });

  test("ignores non-GitHub attachments when hydrating task pull requests", async () => {
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

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    const task = await taskSystem.getTask("ENG-123");

    expect(task.pullRequests).toEqual([
      {
        repoKey: "repo-a",
        url: "https://github.com/acme/repo-a/pull/1",
        title: "PR 1",
        source: "provider_inferred",
      },
    ]);
  });
});

describe("LinearTaskSystem.createTask", () => {
  test("creates ready child issues with execution labels and normalized Agent metadata", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanTeamInfo")) {
        return new Response(
          JSON.stringify({
            data: {
              teams: {
                nodes: [
                  {
                    id: "team-engineering",
                    name: "Engineering",
                    states: { nodes: [{ id: "state-todo", name: "Todo" }] },
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (body.query.includes("query ForemanLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issueLabels: {
                nodes: [
                  { id: "label-agent", name: "Agent" },
                  { id: "label-agent-created", name: "Agent Created" },
                ],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (body.query.includes("query ForemanViewer")) {
        return new Response(JSON.stringify({ data: { viewer: { id: "user-123", name: "Test User" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (body.query.includes("mutation ForemanIssueCreate")) {
        return new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: { id: "issue-child", identifier: "ENG-124", url: "https://linear.app/acme/issue/ENG-124/follow-up" },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);

    const created = await taskSystem.createTask({
      parentTask: { id: "ENG-123", providerId: "issue-parent" } as any,
      mutation: {
        type: "create_task",
        title: "Follow-up task",
        description: "Do the follow-up work.",
        repos: ["repo-a", "repo-b"],
        priority: "high",
        dependencies: { taskIds: ["ENG-123"], baseTaskId: "ENG-122" },
        repoDependencies: [{ taskTargetRepoKey: "repo-b", dependsOnRepoKey: "repo-a" }],
        branchName: "eng-124",
        baseBranch: "release/base",
      },
    });

    expect(created).toEqual({ id: "ENG-124", providerId: "issue-child", url: "https://linear.app/acme/issue/ENG-124/follow-up" });
    expect(requests).toHaveLength(4);
    expect(requests[3]?.variables).toEqual({
      input: {
        teamId: "team-engineering",
        parentId: "issue-parent",
        title: "Follow-up task",
        description:
          "Do the follow-up work.\n\nAgent:\n  Repos: repo-a, repo-b\n  Repo dependencies: repo-b<-repo-a\n  Depends on tasks: ENG-123\n  Base from task: ENG-122\n  Base branch: release/base\n  Branch: eng-124",
        stateId: "state-todo",
        labelIds: ["label-agent", "label-agent-created"],
        priority: 2,
        assigneeId: "user-123",
      },
    });
  });

  test("resolves named assignees when creating child issues", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanTeamInfo")) {
        return new Response(
          JSON.stringify({
            data: {
              teams: {
                nodes: [
                  {
                    id: "team-engineering",
                    name: "Engineering",
                    states: { nodes: [{ id: "state-todo", name: "Todo" }] },
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (body.query.includes("query ForemanLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issueLabels: {
                nodes: [
                  { id: "label-agent", name: "Agent" },
                  { id: "label-agent-created", name: "Agent Created" },
                ],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (body.query.includes("query ForemanAssigneeByName")) {
        return new Response(
          JSON.stringify({ data: { users: { nodes: [{ id: "user-jane", name: "Jane Doe" }] } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (body.query.includes("mutation ForemanIssueCreate")) {
        return new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: { id: "issue-child", identifier: "ENG-124", url: "https://linear.app/acme/issue/ENG-124/follow-up" },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.assignee = "Jane Doe";
    const taskSystem = new LinearTaskSystem(config, { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);

    await taskSystem.createTask({
      parentTask: { id: "ENG-123", providerId: "issue-parent" } as any,
      mutation: {
        type: "create_task",
        title: "Follow-up task",
        description: "Do the follow-up work.",
        repos: ["repo-a"],
      },
    });

    expect(requests).toHaveLength(4);
    expect(requests[2]?.query).toContain("query ForemanAssigneeByName");
    expect(requests[2]?.variables).toEqual({ name: "Jane Doe" });
    expect(requests[3]?.variables).toMatchObject({
      input: {
        assigneeId: "user-jane",
      },
    });
  });
});

describe("LinearTaskSystem.transition", () => {
  test("transitions deployable tasks to the configured Ready to Deploy state", async () => {
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
                        { id: "state-ready-to-deploy", name: "Ready to Deploy" },
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

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    await taskSystem.transition({ taskId: "ENG-123", toState: "deployable" });

    expect(requests[2]?.variables).toEqual({
      id: "issue-1",
      stateId: "state-ready-to-deploy",
    });
  });

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

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
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

describe("LinearTaskSystem.upsertPullRequest", () => {
  test("creates a Linear attachment for GitHub pull request URLs", async () => {
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

      if (body.query.includes("mutation ForemanPullRequestAttachmentCreate")) {
        return new Response(JSON.stringify({ data: { attachmentCreate: { success: true } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    await taskSystem.upsertPullRequest({
      taskId: "ENG-123",
      pullRequest: {
        repoKey: "repo-a",
        url: "https://github.com/acme/repo-a/pull/1",
        title: "PR 1",
        source: "local",
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.query).toContain("query ForemanIssue");
    expect(requests[1]?.query).toContain("mutation ForemanPullRequestAttachmentCreate");
    expect(requests[1]?.variables).toEqual({
      issueId: "issue-1",
      title: "PR 1",
      url: "https://github.com/acme/repo-a/pull/1",
    });
  });

  test("skips duplicate Linear attachments with the same pull request URL", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanIssue")) {
        return new Response(
          JSON.stringify({ data: linearIssue([{ id: "att-pr", title: "PR 1", url: "https://github.com/acme/repo-a/pull/1" }]) }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    await taskSystem.upsertPullRequest({
      taskId: "ENG-123",
      pullRequest: {
        repoKey: "repo-a",
        url: "https://github.com/acme/repo-a/pull/1",
        title: "PR 1",
        source: "local",
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toContain("query ForemanIssue");
  });

  test("does not create Linear attachments for non-GitHub pull request URLs", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);
      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    await taskSystem.upsertPullRequest({
      taskId: "ENG-123",
      pullRequest: {
        repoKey: "repo-a",
        url: "https://example.com/pull/1",
        title: "PR 1",
        source: "local",
      },
    });

    expect(requests).toHaveLength(0);
  });

  test("creates an additional attachment when Linear has a different GitHub pull request", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanIssue")) {
        return new Response(
          JSON.stringify({ data: linearIssue([{ id: "att-pr-2", title: "PR 2", url: "https://github.com/acme/repo-a/pull/2" }]) }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (body.query.includes("mutation ForemanPullRequestAttachmentCreate")) {
        return new Response(JSON.stringify({ data: { attachmentCreate: { success: true } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], fakeLogger as any);
    await taskSystem.upsertPullRequest({
      taskId: "ENG-123",
      pullRequest: {
        repoKey: "repo-a",
        url: "https://github.com/acme/repo-a/pull/1",
        title: "PR 1",
        source: "local",
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.query).toContain("mutation ForemanPullRequestAttachmentCreate");
    expect(requests[1]?.variables).toEqual({
      issueId: "issue-1",
      title: "PR 1",
      url: "https://github.com/acme/repo-a/pull/1",
    });
  });

  test("logs a warning and continues when Linear attachment creation fails", async () => {
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

      if (body.query.includes("mutation ForemanPullRequestAttachmentCreate")) {
        return new Response(JSON.stringify({ errors: [{ message: "attachment rejected" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], logger as any);
    await expect(
      taskSystem.upsertPullRequest({
        taskId: "ENG-123",
        pullRequest: {
          repoKey: "repo-a",
          url: "https://github.com/acme/repo-a/pull/1",
          title: "PR 1",
          source: "local",
        },
      }),
    ).resolves.toBeUndefined();

    expect(requests).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith("failed to create Linear pull request attachment", {
      taskId: "ENG-123",
      providerId: "issue-1",
      repoKey: "repo-a",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/1",
      source: "local",
      error: "Linear request failed: attachment rejected",
    });
  });

  test("logs a warning and continues when Linear issue lookup fails", async () => {
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
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      requests.push(body);

      if (body.query.includes("query ForemanIssue")) {
        return new Response("Bad Gateway", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "content-type": "text/plain" },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;

    const taskSystem = new LinearTaskSystem(createDefaultWorkspaceConfig("foo", "linear"), { LINEAR_API_KEY: "test-key" }, [], logger as any);
    await expect(
      taskSystem.upsertPullRequest({
        taskId: "ENG-123",
        pullRequest: {
          repoKey: "repo-a",
          url: "https://github.com/acme/repo-a/pull/1",
          title: "PR 1",
          source: "local",
        },
      }),
    ).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith("failed to sync Linear pull request attachment", {
      taskId: "ENG-123",
      repoKey: "repo-a",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/1",
      source: "local",
      error: "Linear request failed: 502 Bad Gateway",
    });
  });
});

describe("priority mapping", () => {
  test.each([
    ["Urgent", "urgent"],
    ["High", "high"],
    ["Medium", "normal"],
    ["Normal", "normal"],
    ["Low", "low"],
    ["No priority", "none"],
    ["", "none"],
    [null, "none"],
  ] as const)("linearPriorityToNormalized(%j) -> %j", (label, expected) => {
    expect(linearPriorityToNormalized(label)).toBe(expected);
  });

  test.each([
    ["urgent", 1],
    ["high", 2],
    ["normal", 3],
    ["low", 4],
    ["none", 0],
  ] as const)("normalizedPriorityToLinear(%j) -> %d", (priority, expected) => {
    expect(normalizedPriorityToLinear(priority)).toBe(expected);
  });

  test.each([
    ["urgent", "Urgent"],
    ["high", "High"],
    ["normal", "Medium"],
    ["low", "Low"],
    ["none", "No priority"],
  ] as const)("round-trips Foreman %j through Linear label %j", (priority, linearLabel) => {
    expect(linearPriorityToNormalized(linearLabel)).toBe(priority);
  });
});
