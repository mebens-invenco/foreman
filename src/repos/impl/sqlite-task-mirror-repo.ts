import { newId } from "../../lib/ids.js";
import { stableStringify } from "../../lib/json.js";
import { isoNow } from "../../lib/time.js";
import { resolveTaskRepoDependencies, resolveTaskTargets, type Task, type TaskArtifact } from "../../domain/index.js";
import type {
  GetTasksOptions,
  TaskDependencyRecord,
  TaskMirrorRepo,
  TaskTargetDependencyRecord,
  TaskTargetRecord,
} from "../task-mirror-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

type StoredTaskRecord = {
  id: string;
  provider: Task["provider"];
  providerId: string;
  title: string;
  description: string;
  state: Task["state"];
  providerState: string;
  priority: Task["priority"];
  assignee: string | null;
  url: string | null;
  updatedAt: string;
  syncedAt: string;
  labels: string[];
  artifacts: TaskArtifact[];
};

const TASK_COLUMNS = [
  "id",
  "provider",
  "provider_id",
  "title",
  "description",
  "state",
  "provider_state",
  "priority",
  "assignee",
  "url",
  "updated_at",
  "synced_at",
  "labels_json",
  "artifacts_json",
].join(", ");

const normalizeIds = (ids: readonly string[]): string[] => Array.from(new Set(ids.filter((id) => id.length > 0)));
const normalizeTimestamp = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return fallback;
};

const mapStoredTask = (row: unknown): StoredTaskRecord => {
  const mapped = row as SqliteRow;
  return {
    id: String(mapped.id),
    provider: mapped.provider as StoredTaskRecord["provider"],
    providerId: String(mapped.provider_id),
    title: String(mapped.title),
    description: String(mapped.description),
    state: mapped.state as StoredTaskRecord["state"],
    providerState: String(mapped.provider_state),
    priority: mapped.priority as StoredTaskRecord["priority"],
    assignee: (mapped.assignee as string | null) ?? null,
    url: (mapped.url as string | null) ?? null,
    updatedAt: String(mapped.updated_at),
    syncedAt: String(mapped.synced_at),
    labels: JSON.parse(String(mapped.labels_json ?? "[]")),
    artifacts: JSON.parse(String(mapped.artifacts_json ?? "[]")),
  };
};

const mapTaskTarget = (row: unknown): TaskTargetRecord => {
  const mapped = row as SqliteRow;
  return {
    id: String(mapped.id),
    taskId: String(mapped.task_id),
    repoKey: String(mapped.repo_key),
    branchName: String(mapped.branch_name),
    position: Number(mapped.position),
    createdAt: String(mapped.created_at),
    updatedAt: String(mapped.updated_at),
  };
};

const mapTaskDependency = (row: unknown): TaskDependencyRecord => {
  const mapped = row as SqliteRow;
  return {
    id: String(mapped.id),
    taskId: String(mapped.task_id),
    dependsOnTaskId: String(mapped.depends_on_task_id),
    position: Number(mapped.position),
    isBaseDependency: Number(mapped.is_base_dependency) === 1,
  };
};

const mapTaskTargetDependency = (row: unknown): TaskTargetDependencyRecord => {
  const mapped = row as SqliteRow;
  return {
    id: String(mapped.id),
    taskTargetId: String(mapped.task_target_id),
    dependsOnTaskTargetId: String(mapped.depends_on_task_target_id),
    position: Number(mapped.position),
    source: mapped.source as TaskTargetDependencyRecord["source"],
  };
};

export class SqliteTaskMirrorRepo implements TaskMirrorRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  private selectTaskIds(options: GetTasksOptions = {}): string[] {
    const normalizedIds = normalizeIds(options.taskIds ?? []);
    if (options.taskIds !== undefined && normalizedIds.length === 0) {
      return [];
    }

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (normalizedIds.length > 0) {
      clauses.push(`id IN (${normalizedIds.map(() => "?").join(", ")})`);
      params.push(...normalizedIds);
    }

    if (options.state) {
      clauses.push("state = ?");
      params.push(options.state);
    }

    const search = options.search?.trim().toLowerCase();
    if (search) {
      clauses.push("(LOWER(id) LIKE ? OR LOWER(title) LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT id FROM task${where} ORDER BY updated_at DESC, id ASC${typeof options.limit === "number" ? " LIMIT ?" : ""}`;
    if (typeof options.limit === "number") {
      params.push(options.limit);
    }

    return this.sqlite
      .prepare(sql)
      .all(...params)
      .map((row) => String((row as SqliteRow).id));
  }

  private selectStoredTasks(taskIds: readonly string[]): StoredTaskRecord[] {
    const normalizedIds = normalizeIds(taskIds);
    if (normalizedIds.length === 0) {
      return [];
    }

    const storedTasks = this.sqlite
      .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE id IN (${normalizedIds.map(() => "?").join(", ")})`)
      .all(...normalizedIds)
      .map(mapStoredTask);
    const tasksById = new Map(storedTasks.map((task) => [task.id, task]));
    return normalizedIds.flatMap((taskId) => {
      const task = tasksById.get(taskId);
      return task ? [task] : [];
    });
  }

  private selectTargets(taskIds: readonly string[]): TaskTargetRecord[] {
    const normalizedIds = normalizeIds(taskIds);
    if (normalizedIds.length === 0) {
      return [];
    }

    return this.sqlite
      .prepare(
        `SELECT id, task_id, repo_key, branch_name, position, created_at, updated_at
           FROM task_target
          WHERE task_id IN (${normalizedIds.map(() => "?").join(", ")})
          ORDER BY task_id ASC, position ASC, repo_key ASC`,
      )
      .all(...normalizedIds)
      .map(mapTaskTarget);
  }

  private selectDependencies(taskIds: readonly string[]): TaskDependencyRecord[] {
    const normalizedIds = normalizeIds(taskIds);
    if (normalizedIds.length === 0) {
      return [];
    }

    return this.sqlite
      .prepare(
        `SELECT id, task_id, depends_on_task_id, position, is_base_dependency
           FROM task_dependency
          WHERE task_id IN (${normalizedIds.map(() => "?").join(", ")})
          ORDER BY task_id ASC, position ASC, depends_on_task_id ASC`,
      )
      .all(...normalizedIds)
      .map(mapTaskDependency);
  }

  private selectTargetDependencies(taskIds: readonly string[]): TaskTargetDependencyRecord[] {
    const normalizedIds = normalizeIds(taskIds);
    if (normalizedIds.length === 0) {
      return [];
    }

    return this.sqlite
      .prepare(
        `SELECT task_target_dependency.id,
                task_target_dependency.task_target_id,
                task_target_dependency.depends_on_task_target_id,
                task_target_dependency.position,
                task_target_dependency.source
           FROM task_target_dependency
           JOIN task_target ON task_target.id = task_target_dependency.task_target_id
          WHERE task_target.task_id IN (${normalizedIds.map(() => "?").join(", ")})
          ORDER BY task_target.task_id ASC, task_target_dependency.position ASC, task_target_dependency.depends_on_task_target_id ASC`,
      )
      .all(...normalizedIds)
      .map(mapTaskTargetDependency);
  }

  private hydrateTasks(taskIds: readonly string[]): Task[] {
    const storedTasks = this.selectStoredTasks(taskIds);
    if (storedTasks.length === 0) {
      return [];
    }

    const targetsByTaskId = new Map<string, TaskTargetRecord[]>();
    for (const target of this.selectTargets(storedTasks.map((task) => task.id))) {
      const existing = targetsByTaskId.get(target.taskId) ?? [];
      existing.push(target);
      targetsByTaskId.set(target.taskId, existing);
    }

    const dependenciesByTaskId = new Map<string, TaskDependencyRecord[]>();
    for (const dependency of this.selectDependencies(storedTasks.map((task) => task.id))) {
      const existing = dependenciesByTaskId.get(dependency.taskId) ?? [];
      existing.push(dependency);
      dependenciesByTaskId.set(dependency.taskId, existing);
    }

    const targetDependenciesByTaskId = new Map<string, TaskTargetDependencyRecord[]>();
    const targetTaskIdByTargetId = new Map<string, string>();
    for (const target of this.selectTargets(storedTasks.map((task) => task.id))) {
      targetTaskIdByTargetId.set(target.id, target.taskId);
    }
    for (const dependency of this.selectTargetDependencies(storedTasks.map((task) => task.id))) {
      const taskId = targetTaskIdByTargetId.get(dependency.taskTargetId);
      if (!taskId) {
        continue;
      }
      const existing = targetDependenciesByTaskId.get(taskId) ?? [];
      existing.push(dependency);
      targetDependenciesByTaskId.set(taskId, existing);
    }

    return storedTasks.map((storedTask) => {
      const targets = targetsByTaskId.get(storedTask.id) ?? [];
      const dependencies = dependenciesByTaskId.get(storedTask.id) ?? [];
      const targetDependencies = targetDependenciesByTaskId.get(storedTask.id) ?? [];
      const targetsById = new Map(targets.map((target) => [target.id, target]));
      const primaryTarget = targets.length === 1 ? targets[0] : null;
      const commonBranchName =
        targets.length > 0 && new Set(targets.map((target) => target.branchName)).size === 1 ? targets[0]?.branchName ?? null : null;
      return {
        id: storedTask.id,
        provider: storedTask.provider,
        providerId: storedTask.providerId,
        title: storedTask.title,
        description: storedTask.description,
        state: storedTask.state,
        providerState: storedTask.providerState,
        priority: storedTask.priority,
        labels: storedTask.labels,
        assignee: storedTask.assignee,
        repo: primaryTarget?.repoKey ?? null,
        branchName: primaryTarget?.branchName ?? commonBranchName,
        ...(targets.length > 0
          ? {
              targets: targets.map((target) => ({
                repo: target.repoKey,
                branchName: target.branchName,
                position: target.position,
              })),
            }
          : {}),
        ...(targetDependencies.some((dependency) => dependency.source === "metadata")
          ? {
              repoDependencies: targetDependencies.flatMap((dependency) => {
                if (dependency.source !== "metadata") {
                  return [];
                }
                const sourceTarget = targetsById.get(dependency.taskTargetId);
                const dependsOnTarget = targetsById.get(dependency.dependsOnTaskTargetId);
                if (!sourceTarget || !dependsOnTarget) {
                  return [];
                }
                return [
                  {
                    repo: sourceTarget.repoKey,
                    dependsOnRepo: dependsOnTarget.repoKey,
                    position: dependency.position,
                  },
                ];
              }),
            }
          : {}),
        dependencies: {
          taskIds: dependencies.map((dependency) => dependency.dependsOnTaskId),
          baseTaskId: dependencies.find((dependency) => dependency.isBaseDependency)?.dependsOnTaskId ?? null,
          branchNames: [],
        },
        artifacts: storedTask.artifacts,
        updatedAt: storedTask.updatedAt,
        url: storedTask.url,
      } satisfies Task;
    });
  }

  private rebuildDerivedTargetDependencies(): void {
    this.sqlite.prepare("DELETE FROM task_target_dependency WHERE source = 'derived'").run();
    const rows = this.sqlite
      .prepare(
        `SELECT source_target.id AS task_target_id,
                dependency_target.id AS depends_on_task_target_id,
                task_dependency.position AS position
           FROM task_dependency
           JOIN task_target AS source_target ON source_target.task_id = task_dependency.task_id
           JOIN task_target AS dependency_target
             ON dependency_target.task_id = task_dependency.depends_on_task_id
            AND dependency_target.repo_key = source_target.repo_key
          ORDER BY task_dependency.task_id ASC, source_target.position ASC, task_dependency.position ASC, dependency_target.position ASC`,
      )
      .all() as SqliteRow[];

    const insertTargetDependency = this.sqlite.prepare(
      `INSERT INTO task_target_dependency(
         id, task_target_id, depends_on_task_target_id, position, source
        ) VALUES (?, ?, ?, ?, 'derived')`,
    );

    for (const row of rows) {
      insertTargetDependency.run(newId(), row.task_target_id, row.depends_on_task_target_id, row.position);
    }
  }

  saveTasks(tasks: Task[]): void {
    if (tasks.length === 0) {
      return;
    }

    const syncedAt = isoNow();
    const upsertTask = this.sqlite.prepare(
      `INSERT INTO task(
         id, provider, provider_id, title, description, state, provider_state, priority,
         assignee, url, updated_at, synced_at, labels_json, artifacts_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider = excluded.provider,
         provider_id = excluded.provider_id,
         title = excluded.title,
         description = excluded.description,
         state = excluded.state,
         provider_state = excluded.provider_state,
         priority = excluded.priority,
         assignee = excluded.assignee,
         url = excluded.url,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at,
         labels_json = excluded.labels_json,
         artifacts_json = excluded.artifacts_json`,
    );
    const deleteTargets = this.sqlite.prepare("DELETE FROM task_target WHERE task_id = ?");
    const insertTarget = this.sqlite.prepare(
      `INSERT INTO task_target(
         id, task_id, repo_key, branch_name, position, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteDependencies = this.sqlite.prepare("DELETE FROM task_dependency WHERE task_id = ?");
    const hasTask = this.sqlite.prepare("SELECT 1 AS present FROM task WHERE id = ? LIMIT 1");
    const insertDependency = this.sqlite.prepare(
      `INSERT INTO task_dependency(
         id, task_id, depends_on_task_id, position, is_base_dependency
        ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertTargetDependency = this.sqlite.prepare(
      `INSERT INTO task_target_dependency(
         id, task_target_id, depends_on_task_target_id, position, source
       ) VALUES (?, ?, ?, ?, 'metadata')`,
    );

    this.sqlite.transaction(() => {
      const dependenciesByTaskId = new Map<
        string,
        Array<{ dependsOnTaskId: string; position: number; isBaseDependency: boolean }>
      >();
      const metadataTargetDependencies: Array<{ taskTargetId: string; dependsOnTaskTargetId: string; position: number }> = [];

      for (const task of tasks) {
        upsertTask.run(
          task.id,
          task.provider,
          task.providerId ?? task.id,
          task.title ?? task.id,
          task.description ?? "",
          task.state,
          task.providerState ?? task.state,
          task.priority,
          task.assignee ?? null,
          task.url ?? null,
          normalizeTimestamp(task.updatedAt, syncedAt),
          syncedAt,
          stableStringify(task.labels ?? []),
          stableStringify(task.artifacts ?? []),
        );

        deleteTargets.run(task.id);
        const targets = resolveTaskTargets(task);
        const insertedTargets = new Map<string, string>();
        for (const target of targets) {
          const targetId = newId();
          insertedTargets.set(target.repo, targetId);
          insertTarget.run(targetId, task.id, target.repo, target.branchName, target.position, syncedAt, syncedAt);
        }

        for (const dependency of resolveTaskRepoDependencies(task)) {
          const targetId = insertedTargets.get(dependency.repo);
          const dependsOnTargetId = insertedTargets.get(dependency.dependsOnRepo);
          if (!targetId || !dependsOnTargetId) {
            continue;
          }
          metadataTargetDependencies.push({
            taskTargetId: targetId,
            dependsOnTaskTargetId: dependsOnTargetId,
            position: dependency.position,
          });
        }

        deleteDependencies.run(task.id);
        const dependencyIds = [...task.dependencies.taskIds];
        if (task.dependencies.baseTaskId && !dependencyIds.includes(task.dependencies.baseTaskId)) {
          dependencyIds.push(task.dependencies.baseTaskId);
        }
        dependenciesByTaskId.set(
          task.id,
          dependencyIds.map((dependencyId, position) => ({
            dependsOnTaskId: dependencyId,
            position,
            isBaseDependency: dependencyId === task.dependencies.baseTaskId,
          })),
        );
      }

      for (const [taskId, dependencies] of dependenciesByTaskId) {
        for (const dependency of dependencies) {
          if (!hasTask.get(dependency.dependsOnTaskId)) {
            continue;
          }
          insertDependency.run(
            newId(),
            taskId,
            dependency.dependsOnTaskId,
            dependency.position,
            dependency.isBaseDependency ? 1 : 0,
          );
        }
      }

      for (const dependency of metadataTargetDependencies) {
        insertTargetDependency.run(newId(), dependency.taskTargetId, dependency.dependsOnTaskTargetId, dependency.position);
      }

      this.rebuildDerivedTargetDependencies();
    })();
  }

  getTask(taskId: string): Task | null {
    return this.hydrateTasks([taskId])[0] ?? null;
  }

  getTasks(options: GetTasksOptions = {}): Task[] {
    return this.hydrateTasks(this.selectTaskIds(options));
  }

  getTargetsForTask(taskId: string): TaskTargetRecord[] {
    return this.selectTargets([taskId]);
  }

  getDependenciesForTask(taskId: string): TaskDependencyRecord[] {
    return this.selectDependencies([taskId]);
  }

  getTargetDependenciesForTask(taskId: string): TaskTargetDependencyRecord[] {
    return this.sqlite
      .prepare(
        `SELECT task_target_dependency.id,
                task_target_dependency.task_target_id,
                task_target_dependency.depends_on_task_target_id,
                task_target_dependency.position,
                task_target_dependency.source
           FROM task_target_dependency
           JOIN task_target ON task_target.id = task_target_dependency.task_target_id
          WHERE task_target.task_id = ?
          ORDER BY task_target_dependency.position ASC, task_target_dependency.depends_on_task_target_id ASC`,
      )
      .all(taskId)
      .map(mapTaskTargetDependency);
  }
}
