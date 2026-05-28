import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { RepoRef, Task } from "../../domain/index.js";
import { createTempDir, createWorkspacePaths } from "../../test-support/helpers.js";
import { ensureTaskWorktree } from "../git-worktrees.js";

const processMocks = vi.hoisted(() => ({
  exec: vi.fn(),
}));

vi.mock("../../lib/process.js", () => ({
  exec: processMocks.exec,
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
};

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const cleanupDirs: string[] = [];

afterEach(async () => {
  processMocks.exec.mockReset();
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const createTask = (id: string, repoKey: string): Task => ({
  id,
  provider: "file",
  providerId: id,
  title: "Test task",
  description: "",
  state: "ready",
  providerState: "ready",
  priority: "normal",
  labels: [],
  assignee: null,
  targets: [{ repoKey, branchName: "main", position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-03-20T00:00:00Z",
  url: null,
});

const createRepo = (root: string, key: string): RepoRef => ({
  key,
  rootPath: path.join(root, key),
  defaultBranch: "main",
});

const setupFetchBlockingExec = () => {
  const fetchStarts = [deferred<void>(), deferred<void>()];
  const fetchReleases = [deferred<void>(), deferred<void>()];
  let activeFetches = 0;
  let maxActiveFetches = 0;
  let fetchCount = 0;

  processMocks.exec.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === "fetch") {
      const index = fetchCount;
      fetchCount += 1;
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      fetchStarts[index]?.resolve();
      await fetchReleases[index]?.promise;
      activeFetches -= 1;
    }

    return { stdout: "", stderr: "", exitCode: 0 };
  });

  return {
    fetchStarts,
    fetchReleases,
    get activeFetches() {
      return activeFetches;
    },
    get maxActiveFetches() {
      return maxActiveFetches;
    },
    get fetchCount() {
      return fetchCount;
    },
  };
};

describe("worktree fetch serialization", () => {
  test("serializes origin fetches for concurrent worktree setup in the same repo root", async () => {
    const root = await createTempDir("foreman-git-worktree-fetch-lock-");
    cleanupDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const paths = createWorkspacePaths("/project", workspaceRoot);
    const repo = createRepo(root, "repo-a");
    const fetches = setupFetchBlockingExec();

    const first = ensureTaskWorktree({
      paths,
      repo,
      task: createTask("TASK-1", repo.key),
      baseBranch: "main",
      action: "execution",
    });
    const second = ensureTaskWorktree({
      paths,
      repo,
      task: createTask("TASK-2", repo.key),
      baseBranch: "main",
      action: "execution",
    });

    await fetches.fetchStarts[0]?.promise;
    await flushPromises();

    expect(fetches.fetchCount).toBe(1);
    expect(fetches.activeFetches).toBe(1);

    fetches.fetchReleases[0]?.resolve();
    await fetches.fetchStarts[1]?.promise;

    expect(fetches.activeFetches).toBe(1);
    expect(fetches.maxActiveFetches).toBe(1);

    fetches.fetchReleases[1]?.resolve();
    await Promise.all([first, second]);

    expect(fetches.fetchCount).toBe(2);
    expect(fetches.maxActiveFetches).toBe(1);
  });

  test("allows origin fetches for different repo roots to overlap", async () => {
    const root = await createTempDir("foreman-git-worktree-fetch-lock-");
    cleanupDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const paths = createWorkspacePaths("/project", workspaceRoot);
    const fetches = setupFetchBlockingExec();

    const first = ensureTaskWorktree({
      paths,
      repo: createRepo(root, "repo-a"),
      task: createTask("TASK-1", "repo-a"),
      baseBranch: "main",
      action: "execution",
    });
    const second = ensureTaskWorktree({
      paths,
      repo: createRepo(root, "repo-b"),
      task: createTask("TASK-2", "repo-b"),
      baseBranch: "main",
      action: "execution",
    });

    await Promise.all([fetches.fetchStarts[0]?.promise, fetches.fetchStarts[1]?.promise]);

    expect(fetches.activeFetches).toBe(2);
    expect(fetches.maxActiveFetches).toBe(2);

    fetches.fetchReleases[0]?.resolve();
    fetches.fetchReleases[1]?.resolve();
    await Promise.all([first, second]);
  });
});
