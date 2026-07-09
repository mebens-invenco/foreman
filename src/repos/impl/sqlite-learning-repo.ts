import { ForemanError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { isoNow } from "../../lib/time.js";
import type {
  LearningEmbeddingRecord,
  LearningReadOptions,
  LearningRecord,
  LearningRepo,
  LearningSearchRecord,
} from "../learning-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

const LEARNING_COLUMNS = "id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at";

const mapLearningRecord = (row: unknown): LearningRecord => {
  const mapped = row as SqliteRow;
  return {
    id: String(mapped.id),
    title: String(mapped.title),
    repo: String(mapped.repo),
    tags: JSON.parse(String(mapped.tags ?? "[]")),
    confidence: mapped.confidence as LearningRecord["confidence"],
    content: String(mapped.content),
    appliedCount: Number(mapped.applied_count),
    readCount: Number(mapped.read_count),
    createdAt: String(mapped.created_at),
    updatedAt: String(mapped.updated_at),
  };
};

const mapLearningSearchRecord = (row: unknown): LearningSearchRecord => {
  const mapped = row as SqliteRow;
  return {
    id: String(mapped.id),
    title: String(mapped.title),
    repo: String(mapped.repo),
    tags: JSON.parse(String(mapped.tags ?? "[]")),
    confidence: mapped.confidence as LearningSearchRecord["confidence"],
    createdAt: String(mapped.created_at),
    updatedAt: String(mapped.updated_at),
    score: Number(mapped.score),
  };
};

const toVectorBlob = (vector: Float32Array): Buffer =>
  Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

// `slice` copies into a fresh, 4-byte-aligned ArrayBuffer. Wrapping the pooled
// buffer in place would throw whenever better-sqlite3 hands back a Buffer at an
// unaligned offset.
const fromVectorBlob = (blob: Buffer): Float32Array =>
  new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

const mapLearningEmbeddingRecord = (row: unknown): LearningEmbeddingRecord => {
  const mapped = row as SqliteRow;
  return {
    learningId: String(mapped.learning_id),
    model: String(mapped.model),
    dims: Number(mapped.dims),
    vector: fromVectorBlob(mapped.vector as Buffer),
  };
};

const normalizeFilterValues = (values: readonly string[] | undefined): string[] =>
  Array.from(new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0)));

const toSafeFtsQuery = (query: string): string =>
  query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" ");

export class SqliteLearningRepo implements LearningRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  private incrementReadCount(ids: readonly string[]): void {
    const normalizedIds = normalizeFilterValues(ids);
    if (normalizedIds.length === 0) {
      return;
    }

    this.sqlite
      .prepare(`UPDATE learning SET read_count = read_count + 1 WHERE id IN (${normalizedIds.map(() => "?").join(", ")})`)
      .run(...normalizedIds);
  }

  addLearning(input: {
    id?: string;
    title: string;
    repo: string;
    confidence: "emerging" | "established" | "proven";
    content: string;
    tags: string[];
  }): string {
    const id = input.id ?? newId();
    this.sqlite
      .prepare(
        "INSERT INTO learning(id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)",
      )
      .run(id, input.title, input.repo, JSON.stringify(input.tags), input.confidence, input.content, isoNow(), isoNow());
    return id;
  }

  updateLearning(input: {
    id: string;
    title?: string;
    repo?: string;
    confidence?: "emerging" | "established" | "proven";
    content?: string;
    tags?: string[];
    markApplied?: boolean;
  }): void {
    const current = this.sqlite
      .prepare("SELECT title, repo, tags, confidence, content, applied_count FROM learning WHERE id = ?")
      .get(input.id) as SqliteRow | undefined;

    if (!current) {
      throw new ForemanError("learning_not_found", `Learning not found: ${input.id}`);
    }

    this.sqlite
      .prepare(
        `UPDATE learning
            SET title = ?, repo = ?, tags = ?, confidence = ?, content = ?, applied_count = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        input.title ?? current.title,
        input.repo ?? current.repo,
        input.tags ? JSON.stringify(input.tags) : current.tags,
        input.confidence ?? current.confidence,
        input.content ?? current.content,
        input.markApplied ? Number(current.applied_count ?? 0) + 1 : current.applied_count,
        isoNow(),
        input.id,
      );
  }

  searchLearnings(
    filters: { queries?: string[]; repos?: string[]; limit?: number; offset?: number } = {},
    options: LearningReadOptions = {},
  ): LearningSearchRecord[] {
    const queries = normalizeFilterValues(filters.queries);
    const repos = normalizeFilterValues(filters.repos);
    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;

    if (queries.length === 0) {
      const repoWhere = repos.length > 0 ? `WHERE repo IN (${repos.map(() => "?").join(", ")})` : "";
      const learnings = this.sqlite
        .prepare(
          `SELECT id, title, repo, tags, confidence, created_at, updated_at, 0.0 AS score
             FROM learning ${repoWhere}
            ORDER BY updated_at DESC, id ASC
            LIMIT ? OFFSET ?`,
        )
        .all(...repos, limit, offset)
        .map(mapLearningSearchRecord);

      if (options.incrementReadCount) {
        this.incrementReadCount(learnings.map((learning) => learning.id));
      }

      return learnings;
    }

    const matchedScores = new Map<number, number>();
    const selectMatches = this.sqlite.prepare("SELECT rowid, bm25(learning_fts) AS score FROM learning_fts WHERE learning_fts MATCH ?");

    for (const query of queries) {
      const rows = selectMatches.all(toSafeFtsQuery(query)) as SqliteRow[];
      for (const row of rows) {
        const rowId = Number(row.rowid);
        const score = Number(row.score);
        const previousScore = matchedScores.get(rowId);
        if (previousScore === undefined || score < previousScore) {
          matchedScores.set(rowId, score);
        }
      }
    }

    const rowIds = Array.from(matchedScores.keys());
    if (rowIds.length === 0) {
      return [];
    }

    const repoWhere = repos.length > 0 ? ` AND repo IN (${repos.map(() => "?").join(", ")})` : "";
    const rows = this.sqlite
      .prepare(
        `SELECT rowid, id, title, repo, tags, confidence, created_at, updated_at
           FROM learning
          WHERE rowid IN (${rowIds.map(() => "?").join(", ")})${repoWhere}`,
      )
      .all(...rowIds, ...repos) as SqliteRow[];

    const learnings = rows
      .map((row) => ({
        ...mapLearningSearchRecord({
          ...row,
          score: matchedScores.get(Number(row.rowid)) ?? Number.POSITIVE_INFINITY,
        }),
      }))
      .sort((left, right) => {
        if (left.score !== right.score) {
          return left.score - right.score;
        }

        if (left.updatedAt !== right.updatedAt) {
          return right.updatedAt.localeCompare(left.updatedAt);
        }

        return left.id.localeCompare(right.id);
      })
      .slice(offset, offset + limit);

    if (options.incrementReadCount) {
      this.incrementReadCount(learnings.map((learning) => learning.id));
    }

    return learnings;
  }

  getLearningsByIds(ids: string[], options: LearningReadOptions = {}): LearningRecord[] {
    const normalizedIds = normalizeFilterValues(ids);
    if (normalizedIds.length === 0) {
      return [];
    }

    const rows = this.sqlite
      .prepare(`SELECT ${LEARNING_COLUMNS} FROM learning WHERE id IN (${normalizedIds.map(() => "?").join(", ")}) ORDER BY id ASC`)
      .all(...normalizedIds)
      .map(mapLearningRecord);
    const rowsById = new Map(rows.map((row) => [row.id, row]));

    const learnings = normalizedIds.flatMap((id) => {
      const learning = rowsById.get(id);
      return learning ? [learning] : [];
    });

    if (options.incrementReadCount) {
      this.incrementReadCount(learnings.map((learning) => learning.id));
    }

    return learnings;
  }

  listLearnings(filters: { search?: string; repo?: string; limit?: number; offset?: number } = {}): LearningRecord[] {
    if (filters.search) {
      const matches = this.searchLearnings({
        queries: [filters.search],
        ...(filters.repo ? { repos: [filters.repo] } : {}),
        ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
        ...(filters.offset !== undefined ? { offset: filters.offset } : {}),
      });
      return this.getLearningsByIds(matches.map((match) => match.id));
    }

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.repo) {
      clauses.push("repo = ?");
      params.push(filters.repo);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const paginationClause =
      filters.limit === undefined
        ? filters.offset === undefined
          ? ""
          : " LIMIT -1 OFFSET ?"
        : " LIMIT ? OFFSET ?";
    const paginationParams =
      filters.limit === undefined
        ? filters.offset === undefined
          ? []
          : [filters.offset]
        : [filters.limit, filters.offset ?? 0];

    return this.sqlite
      .prepare(
        `SELECT ${LEARNING_COLUMNS}
           FROM learning ${where}
           ORDER BY updated_at DESC, id ASC
           ${paginationClause}`,
      )
      .all(...params, ...paginationParams)
      .map(mapLearningRecord);
  }

  upsertLearningEmbedding(input: LearningEmbeddingRecord): void {
    this.sqlite
      .prepare(
        `INSERT INTO learning_embedding(learning_id, model, dims, vector, updated_at)
              VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(learning_id) DO UPDATE
                 SET model = excluded.model,
                     dims = excluded.dims,
                     vector = excluded.vector,
                     updated_at = excluded.updated_at`,
      )
      .run(input.learningId, input.model, input.dims, toVectorBlob(input.vector), isoNow());
  }

  listLearningIdsMissingEmbedding(model: string): string[] {
    return this.sqlite
      .prepare(
        `SELECT learning.id AS id
           FROM learning
           LEFT JOIN learning_embedding ON learning_embedding.learning_id = learning.id
          WHERE learning_embedding.learning_id IS NULL
             OR learning_embedding.model != ?
             OR learning_embedding.updated_at < learning.updated_at
          ORDER BY learning.id ASC`,
      )
      .all(model)
      .map((row) => String((row as SqliteRow).id));
  }

  getLearningEmbeddings(filters: { repos?: string[] } = {}): LearningEmbeddingRecord[] {
    const repos = normalizeFilterValues(filters.repos);
    const repoWhere = repos.length > 0 ? `WHERE learning.repo IN (${repos.map(() => "?").join(", ")})` : "";

    return this.sqlite
      .prepare(
        `SELECT learning_embedding.learning_id, learning_embedding.model, learning_embedding.dims, learning_embedding.vector
           FROM learning_embedding
           JOIN learning ON learning.id = learning_embedding.learning_id
           ${repoWhere}
          ORDER BY learning_embedding.learning_id ASC`,
      )
      .all(...repos)
      .map(mapLearningEmbeddingRecord);
  }
}
