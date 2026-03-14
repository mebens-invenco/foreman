import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { runScoutSelection } from "../src/scout.js";
import { createDefaultWorkspaceConfig } from "../src/config.js";
import { createMigratedDb, createTempDir } from "./helpers.js";
const cleanupDirs = [];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
class FakeTaskSystem {
    tasks;
    comments = new Map();
    constructor(tasks) {
        this.tasks = tasks;
    }
    getProvider() {
        return "file";
    }
    async listCandidates() {
        return this.tasks;
    }
    async getTask(taskId) {
        const task = this.tasks.find((item) => item.id === taskId);
        if (!task) {
            throw new Error(`missing task ${taskId}`);
        }
        return task;
    }
    async listComments(taskId) {
        return this.comments.get(taskId) ?? [];
    }
    async addComment(input) {
        const existing = this.comments.get(input.taskId) ?? [];
        existing.push({
            id: `${input.taskId}-${existing.length + 1}`,
            taskId: input.taskId,
            body: input.body,
            authorName: "agent",
            authorKind: "agent",
            createdAt: new Date().toISOString(),
            updatedAt: null,
        });
        this.comments.set(input.taskId, existing);
    }
    async transition() { }
    async addArtifact() { }
    async updateLabels() { }
}
class FakeReviewService {
    contexts;
    constructor(contexts) {
        this.contexts = contexts;
    }
    async getContext(task, _agentPrefix) {
        return this.contexts[task.id] ?? null;
    }
    async findLatestOpenPullRequestBranch(task) {
        return this.contexts[task.id]?.headBranch ?? null;
    }
    async listConversationComments(_prUrl) {
        return [];
    }
    async createPullRequest(_input) {
        throw new Error("not used");
    }
    async reopenPullRequest(_input) {
        throw new Error("not used");
    }
    async replyToReviewSummary(_prUrl, _reviewId, _body) {
        throw new Error("not used");
    }
    async replyToPrComment(_prUrl, _commentId, _body) {
        throw new Error("not used");
    }
    async resolveThreads(_prUrl, _threadIds) {
        throw new Error("not used");
    }
}
const task = (input) => ({
    provider: "file",
    providerId: input.id,
    description: "",
    labels: ["Agent"],
    assignee: null,
    repo: "repo-a",
    branchName: input.id.toLowerCase(),
    dependencies: { taskIds: [], baseTaskId: null, branchNames: [] },
    artifacts: [],
    url: null,
    ...input,
});
describe("runScoutSelection", () => {
    test("prioritizes review before execution", async () => {
        const tempDir = await createTempDir("foreman-scout-test-");
        cleanupDirs.push(tempDir);
        const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
        const config = createDefaultWorkspaceConfig("foo", "file");
        const reviewTask = task({
            id: "TASK-0002",
            title: "Review task",
            state: "in_review",
            providerState: "in_review",
            priority: "normal",
            updatedAt: "2026-03-14T12:00:00Z",
            artifacts: [{ type: "pull_request", url: "https://github.com/acme/repo-a/pull/1" }],
        });
        const readyTask = task({
            id: "TASK-0001",
            title: "Ready task",
            state: "ready",
            providerState: "ready",
            priority: "urgent",
            updatedAt: "2026-03-14T11:00:00Z",
        });
        const taskSystem = new FakeTaskSystem([readyTask, reviewTask]);
        const reviewService = new FakeReviewService({
            [reviewTask.id]: {
                provider: "github",
                pullRequestUrl: "https://github.com/acme/repo-a/pull/1",
                pullRequestNumber: 1,
                state: "open",
                isDraft: false,
                headSha: "abc",
                headBranch: "task-0002",
                baseBranch: "main",
                headIntroducedAt: "2026-03-14T12:00:00Z",
                mergeState: "clean",
                actionableReviewSummaries: [{ id: "rev-1", body: "Please fix", authorName: "reviewer", createdAt: "2026-03-14T12:01:00Z", commitId: "abc" }],
                actionableConversationComments: [],
                unresolvedThreads: [],
                failingChecks: [],
                pendingChecks: [],
            },
        });
        try {
            const result = await runScoutSelection({
                config,
                db,
                taskSystem,
                reviewService,
                repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
                triggerType: "manual",
            });
            expect(result.jobs).toHaveLength(2);
            expect(result.jobs[0]?.action).toBe("review");
            expect(result.jobs[0]?.task.id).toBe("TASK-0002");
            expect(result.jobs[1]?.action).toBe("execution");
        }
        finally {
            db.close();
        }
    });
});
//# sourceMappingURL=scout.test.js.map