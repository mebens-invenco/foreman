import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import type { Task } from "../../domain/index.js";
import type { WorkerPromptTemplateName } from "../../prompts/template-renderer.js";
import { FakeEmbedder } from "../../test-support/fake-embedder.js";
import { createMigratedDb, createTempDir, seedExecutionAttempt, testProjectRoot } from "../../test-support/helpers.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";
import type { WorkspacePaths } from "../../workspace/workspace-paths.js";
import { renderWorkerPrompt } from "../render-worker-prompt.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const task: Task = {
  id: "ENG-1",
  provider: "linear",
  providerId: "ENG-1",
  title: "vector retrieval tuning",
  description: "Rank the learnings.",
  state: "ready",
  providerState: "Todo",
  priority: "none",
  labels: [],
  assignee: null,
  targets: [{ repoKey: "foreman", branchName: "eng-1", position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-07-13T00:00:00Z",
  url: null,
};

const taskQuery = `${task.title}\n${task.description}`;

type Db = Awaited<ReturnType<typeof createMigratedDb>>;

const seedRelevantCorpus = (db: Db): void => {
  db.learnings.addLearning({
    id: "learn-target",
    title: "Rank the fused arms",
    repo: "shared",
    confidence: "established",
    content: "**Rule:** Rank both arms before fusing.\n**When to apply:** Whenever retrieval fuses two rankings.",
    tags: [],
  });
  db.learnings.upsertLearningEmbedding({
    learningId: "learn-target",
    model: "fake-embedder-v1",
    dims: 3,
    vector: Float32Array.from([0, 1, 0]),
    embeddedTitle: "Rank the fused arms",
    embeddedContent: "**Rule:** Rank both arms before fusing.\n**When to apply:** Whenever retrieval fuses two rankings.",
  });

  // Noise around 1 match, so the arm will RANK it: the largest z a corpus of n
  // admits is `(n - 1) / sqrt(n)`, and `COSINE_Z_FLOOR` = 2 needs n >= 6. What the
  // seam then injects is decided by similarity, not by z.
  for (let index = 0; index < 12; index += 1) {
    const content = `filler ${index} unrelated`;
    db.learnings.addLearning({ id: `pad-${index}`, title: `pad-${index}`, repo: "shared", confidence: "emerging", content, tags: [] });
    db.learnings.upsertLearningEmbedding({
      learningId: `pad-${index}`,
      model: "fake-embedder-v1",
      dims: 3,
      vector: Float32Array.from([1, 0, 0]),
      embeddedTitle: `pad-${index}`,
      embeddedContent: content,
    });
  }
};

const withWorkspace = async (run: (input: { db: Db; paths: WorkspacePaths }) => Promise<void>): Promise<void> => {
  const workspaceRoot = await createTempDir("foreman-rwp-learnings-test-");
  cleanupDirs.push(workspaceRoot);
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), testProjectRoot);
  const paths: WorkspacePaths = {
    projectRoot: testProjectRoot,
    workspaceRoot,
    configPath: path.join(workspaceRoot, "foreman.workspace.yml"),
    envPath: path.join(workspaceRoot, ".env"),
    dbPath: path.join(workspaceRoot, "foreman.db"),
    logsDir: path.join(workspaceRoot, "logs"),
    attemptsLogDir: path.join(workspaceRoot, "logs", "attempts"),
    artifactsDir: path.join(workspaceRoot, "artifacts"),
    worktreesDir: path.join(workspaceRoot, "worktrees"),
    tasksDir: path.join(workspaceRoot, "tasks"),
    planPath: path.join(workspaceRoot, "plan.md"),
  };

  try {
    renderAttemptId = seedExecutionAttempt(db, { task, repoKey: "foreman", action: "execution" }).id;
    await run({ db, paths });
  } finally {
    db.close();
  }
};

/** Real, not synthetic: injection's telemetry row carries a foreign key to it. */
let renderAttemptId: string;

const render = (input: {
  db: Db;
  paths: WorkspacePaths;
  action: WorkerPromptTemplateName;
  inject: boolean;
  continuation?: boolean;
  projectRoot?: string;
}): Promise<string> => {
  const embedder = new FakeEmbedder();
  embedder.vectorsByText.set(taskQuery, Float32Array.from([0, 1, 0]));

  return renderWorkerPrompt({
    action: input.action,
    config: createDefaultWorkspaceConfig("automation-pilot", "linear"),
    paths: input.projectRoot ? { ...input.paths, projectRoot: input.projectRoot } : input.paths,
    task,
    repo: { key: "foreman", rootPath: path.join(input.paths.workspaceRoot, "foreman"), defaultBranch: "master" },
    worktreePath: path.join(input.paths.workspaceRoot, "foreman"),
    baseBranch: "master",
    ...(input.continuation ? { continuation: true } : {}),
    ...(input.inject
      ? {
          learningInjection: {
            learnings: input.db.learnings,
            embedder,
            warn: () => {},
            telemetry: { events: input.db.learningInjectionEvents, attemptId: renderAttemptId },
          },
        }
      : {}),
  });
};

const injectedTemplates = ["execution", "retry", "review", "review-continuation"] as const;

/** The rendered cli path is the one thing a different project root legitimately moves. */
const normalizeProjectRoot = (prompt: string): string => prompt.replaceAll(/\S*\/dist\/cli\.js/g, "<cli>");

/**
 * A project root whose templates are the pre-ticket ones: same prompts, with the
 * `relevant-learnings` token and its separator removed. Rendering against it is
 * the only honest baseline for "unchanged" — asserting the absence of a heading
 * would not catch the blank line a naively-replaced token leaves behind.
 */
const projectRootWithoutTheToken = async (): Promise<string> => {
  const root = await createTempDir("foreman-rwp-pre-ticket-");
  cleanupDirs.push(root);
  await fs.cp(path.join(testProjectRoot, "prompts"), path.join(root, "prompts"), { recursive: true });

  for (const name of injectedTemplates) {
    const templatePath = path.join(root, "prompts", "templates", `${name}.md`);
    const template = await fs.readFile(templatePath, "utf8");
    const stripped = template.replace("\n{{context:relevant-learnings}}\n", "");
    expect(stripped).not.toContain("relevant-learnings");
    await fs.writeFile(templatePath, stripped);
  }

  return root;
};

describe("renderWorkerPrompt relevant-learnings injection", () => {
  describe("when the injection dep is supplied", () => {
    test.each([["execution"], ["retry"], ["review"]] as const)("renders the digest into the %s prompt", async (action) => {
      await withWorkspace(async ({ db, paths }) => {
        seedRelevantCorpus(db);

        const prompt = await render({ db, paths, action, inject: true });

        expect(prompt).toContain("## Relevant Learnings");
        expect(prompt).toContain("`learn-target` — Rank the fused arms");
        expect(prompt).toContain("**Rule:** Rank both arms before fusing.");
      });
    });

    test("renders the digest into the review-continuation prompt", async () => {
      await withWorkspace(async ({ db, paths }) => {
        seedRelevantCorpus(db);

        const prompt = await render({ db, paths, action: "review", inject: true, continuation: true });

        expect(prompt).toContain("You are continuing a review session");
        expect(prompt).toContain("## Relevant Learnings");
        expect(prompt).toContain("`learn-target` — Rank the fused arms");
      });
    });

    test("resolves the workspace and action into the fetch instruction", async () => {
      await withWorkspace(async ({ db, paths }) => {
        seedRelevantCorpus(db);

        const prompt = await render({ db, paths, action: "execution", inject: true });

        expect(prompt).toContain("foreman learnings get automation-pilot --id <id> --caller execution");
        expect(prompt).toContain("markApplied: true");
        expect(prompt).not.toContain("{{workspace:name}}");
        expect(prompt).not.toContain("{{session:action}}");
      });
    });

    // DI3: these actions answer to a diff or a pipeline, not to the task text the
    // digest is retrieved against.
    test.each([["reviewer"], ["deployment"], ["consolidation"]] as const)("injects nothing into the %s prompt", async (action) => {
      await withWorkspace(async ({ db, paths }) => {
        seedRelevantCorpus(db);

        const prompt = await render({ db, paths, action, inject: true });

        expect(prompt).not.toContain("Relevant Learnings");
      });
    });

    test("omits the section, leaving the prompt unchanged, when retrieval clears nothing", async () => {
      await withWorkspace(async ({ db, paths }) => {
        const prompt = await render({ db, paths, action: "execution", inject: true });
        const preTicket = await render({ db, paths, action: "execution", inject: false, projectRoot: await projectRootWithoutTheToken() });

        expect(prompt).not.toContain("Relevant Learnings");
        expect(normalizeProjectRoot(prompt)).toBe(normalizeProjectRoot(preTicket));
      });
    });
  });

  describe("when the injection dep is absent", () => {
    // The eval harness renders through this path: a prompt whose learnings section
    // shifts with the live workspace corpus is not a fixture. Byte-identity is
    // proven against the pre-ticket templates, not merely asserted as an absence.
    test.each(injectedTemplates)("renders the %s prompt byte-identically to the pre-ticket template", async (name) => {
      await withWorkspace(async ({ db, paths }) => {
        seedRelevantCorpus(db);
        const action = name === "review-continuation" ? "review" : name;
        const continuation = name === "review-continuation";

        const withoutDep = await render({ db, paths, action, inject: false, continuation });
        const preTicket = await render({
          db,
          paths,
          action,
          inject: false,
          continuation,
          projectRoot: await projectRootWithoutTheToken(),
        });

        expect(withoutDep).not.toContain("{{context:relevant-learnings}}");
        expect(normalizeProjectRoot(withoutDep)).toBe(normalizeProjectRoot(preTicket));
      });
    });
  });
});
