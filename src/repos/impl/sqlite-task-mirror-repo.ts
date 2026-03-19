import { newId } from "../../lib/ids.js";
import { stableStringify } from "../../lib/json.js";
import { isoNow } from "../../lib/time.js";
import { taskTargetFromTask, type Task, type TaskTarget } from "../../domain/index.js";
import type {
  MirroredTaskRecord,
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

  private normalizeTaskTargets(task: Task): TaskTarget[] {
    const explicitTargets = (task as Task & { targets?: TaskTarget[] }).targets;
    if (explicitTargets && explicitTargets.length > 0) {
      return explicitTargets
        .map((target, position) => ({ ...target, position: target.position ?? position }))
        .sort((left, right) => left.position - right.position || left.repoKey.localeCompare(right.repoKey));
    }

    const fallbackTarget = taskTargetFromTask(task);
    return fallbackTarget ? [fallbackTarget] : [];
  }

  private selectStoredTasks(taskIds: readonly string[]): StoredTaskRecord[] {
    const normalizedIds = normalizeIds(taskIds);
    if (normalizedIds.length === 0) {
      return [];
    }

    return this.sqlite
      .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE id IN (${normalizedIds.map(() => "?").join(", ")}) ORDER BY id ASC`)
      .all(...normalizedIds)
      .map(mapStoredTask);
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

    return storedTasks.map((storedTask) => {
      const targets = targetsByTaskId.get(storedTask.id) ?? [];
      const dependencies = dependenciesByTaskId.get(storedTask.id) ?? [];
      const primaryTarget = targets.length === 1 ? targets[0] : null;
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
        branchName: primaryTarget?.branchName ?? null,
        dependencies: {
          taskIds: dependencies.map((dependency) => dependency.dependsOnTaskId),
          baseTaskId: dependencies.find((dependency) => dependency.isBaseDependency)?.dependsOnTaskId ?? null,
          branchNames: [],
        },
        artifacts: [],
        updatedAt: storedTask.updatedAt,
        url: storedTask.url,
      } satisfies Task;
    });
  }

  private rebuildTargetDependencies(): void {
    this.sqlite.prepare("DELETE FROM task_target_dependency").run();
    const rows = this.sqlite
      .prepare(
        `WITH single_target AS (
           SELECT task_id, MIN(id) AS target_id
             FROM task_target
            GROUP BY task_id
           HAVING COUNT(*) = 1
         )
         SELECT source_target.target_id AS task_target_id,
                dependency_target.target_id AS depends_on_task_target_id,
                task_dependency.position AS position
           FROM task_dependency
           JOIN single_target AS source_target ON source_target.task_id = task_dependency.task_id
           JOIN single_target AS dependency_target ON dependency_target.task_id = task_dependency.depends_on_task_id
          ORDER BY task_dependency.task_id ASC, task_dependency.position ASC, task_dependency.depends_on_task_id ASC`,
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

  syncTasks(tasks: Task[]): void {
    this.saveTasks(tasks);
  }

  saveTasks(tasks: Task[]): void {
    if (tasks.length === 0) {
      return;
    }

    const syncedAt = isoNow();
    const upsertTask = this.sqlite.prepare(
      `INSERT INTO task(
         id, provider, provider_id, title, description, state, provider_state, priority,
         assignee, url, updated_at, synced_at, labels_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         labels_json = excluded.labels_json`,
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

    this.sqlite.transaction(() => {
      const dependenciesByTaskId = new Map<
        string,
        Array<{ dependsOnTaskId: string; position: number; isBaseDependency: boolean }>
      >();

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
        );

        deleteTargets.run(task.id);
        for (const target of this.normalizeTaskTargets(task)) {
          insertTarget.run(newId(), task.id, target.repoKey, target.branchName, target.position, syncedAt, syncedAt);
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

      this.rebuildTargetDependencies();
    })();
  }

  getTask(taskId: string): Task | null {
    return this.hydrateTasks([taskId])[0] ?? null;
  }

  getTasks(taskIds: string[]): Task[] {
    const normalizedIds = normalizeIds(taskIds);
    const tasks = this.hydrateTasks(normalizedIds);
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    return normalizedIds.flatMap((taskId) => {
      const task = tasksById.get(taskId);
      return task ? [task] : [];
    });
  }

  getMirroredTask(taskId: string): MirroredTaskRecord | null {
    return this.selectStoredTasks([taskId])[0] ?? null;
  }

  getTaskTarget(taskId: string, repoKey: string): TaskTargetRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, task_id, repo_key, branch_name, position, created_at, updated_at
           FROM task_target
          WHERE task_id = ?
            AND repo_key = ?
          LIMIT 1`,
      )
      .get(taskId, repoKey);
    return row ? mapTaskTarget(row) : null;
  }

  getTaskTargetById(taskTargetId: string): TaskTargetRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, task_id, repo_key, branch_name, position, created_at, updated_at
           FROM task_target
          WHERE id = ?`,
      )
      .get(taskTargetId);
    return row ? mapTaskTarget(row) : null;
  }
  listTaskTargets(taskId: string): TaskTargetRecord[] {
    return this.selectTargets([taskId]);
  }

  listTaskDependencies(taskId: string): TaskDependencyRecord[] {
    return this.selectDependencies([taskId]);
  }

  listTaskTargetDependencies(taskId: string): TaskTargetDependencyRecord[] {
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
