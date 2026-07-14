import { newId } from "../../lib/ids.js";
import { isoNow } from "../../lib/time.js";
import type { RetrievalPipeline } from "../../retrieval/retrieval-pipeline.js";
import type {
  LearningSearchEventFilters,
  LearningSearchEventInput,
  LearningSearchEventKind,
  LearningSearchEventRecord,
  LearningSearchEventRepo,
} from "../learning-search-event-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

const EVENT_COLUMNS =
  "id, created_at, kind, caller, queries, repos, requested_ids, hit_ids, hit_scores, zero_hit, pipeline, attempt_id, task_id";

const parseArray = <T>(value: unknown): T[] => JSON.parse(String(value ?? "[]")) as T[];

const mapEventRecord = (row: unknown): LearningSearchEventRecord => {
  const mapped = row as SqliteRow;
  return {
    id: String(mapped.id),
    createdAt: String(mapped.created_at),
    kind: mapped.kind as LearningSearchEventKind,
    caller: (mapped.caller as string | null) ?? null,
    queries: parseArray<string>(mapped.queries),
    repos: parseArray<string>(mapped.repos),
    requestedIds: parseArray<string>(mapped.requested_ids),
    hitIds: parseArray<string>(mapped.hit_ids),
    hitScores: parseArray<number>(mapped.hit_scores),
    zeroHit: Number(mapped.zero_hit) === 1,
    pipeline: (mapped.pipeline as RetrievalPipeline | null) ?? null,
    attemptId: (mapped.attempt_id as string | null) ?? null,
    taskId: (mapped.task_id as string | null) ?? null,
  };
};

export class SqliteLearningSearchEventRepo implements LearningSearchEventRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  recordEvent(input: LearningSearchEventInput): string {
    const id = newId();
    const hitIds = input.hitIds ?? [];
    this.sqlite
      .prepare(
        `INSERT INTO learning_search_event(
          id, created_at, kind, caller, queries, repos, requested_ids, hit_ids, hit_scores, zero_hit, pipeline,
          attempt_id, task_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        isoNow(),
        input.kind,
        input.caller ?? null,
        JSON.stringify(input.queries ?? []),
        JSON.stringify(input.repos ?? []),
        JSON.stringify(input.requestedIds ?? []),
        JSON.stringify(hitIds),
        JSON.stringify(input.hitScores ?? []),
        hitIds.length === 0 ? 1 : 0,
        input.pipeline ?? null,
        input.source?.attemptId ?? null,
        input.source?.taskId ?? null,
      );
    return id;
  }

  listEvents(filters: LearningSearchEventFilters = {}): LearningSearchEventRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.kind) {
      clauses.push("kind = ?");
      params.push(filters.kind);
    }

    if (filters.caller !== undefined) {
      clauses.push("caller = ?");
      params.push(filters.caller);
    }

    if (filters.zeroHit !== undefined) {
      clauses.push("zero_hit = ?");
      params.push(filters.zeroHit ? 1 : 0);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    return this.sqlite
      .prepare(
        `SELECT ${EVENT_COLUMNS}
           FROM learning_search_event ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset)
      .map(mapEventRecord);
  }
}
