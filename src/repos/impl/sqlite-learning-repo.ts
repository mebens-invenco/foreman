import { ForemanError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { isoNow } from "../../lib/time.js";
import type { LearningRecord, LearningRepo, LearningSearchRecord } from "../learning-repo.js";
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

const normalizeFilterValues = (values: readonly string[] | undefined): string[] =>
  Array.from(new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0)));

export class SqliteLearningRepo implements LearningRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

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

  searchLearnings(filters: { queries?: string[]; repos?: string[]; limit?: number; offset?: number } = {}): LearningSearchRecord[] {
    const queries = normalizeFilterValues(filters.queries);
    const repos = normalizeFilterValues(filters.repos);
    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;

    if (queries.length === 0) {
      const repoWhere = repos.length > 0 ? `WHERE repo IN (${repos.map(() => "?").join(", ")})` : "";
      return this.sqlite
        .prepare(
          `SELECT id, title, repo, tags, confidence, created_at, updated_at, 0.0 AS score
             FROM learning ${repoWhere}
            ORDER BY updated_at DESC, id ASC
            LIMIT ? OFFSET ?`,
        )
        .all(...repos, limit, offset)
        .map(mapLearningSearchRecord);
    }

    const matchedScores = new Map<number, number>();
    const selectMatches = this.sqlite.prepare("SELECT rowid, bm25(learning_fts) AS score FROM learning_fts WHERE learning_fts MATCH ?");

    for (const query of queries) {
      const rows = selectMatches.all(query) as SqliteRow[];
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

    return rows
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
  }

  getLearningsById(ids: string[]): LearningRecord[] {
    const normalizedIds = normalizeFilterValues(ids);
    if (normalizedIds.length === 0) {
      return [];
    }

    const rows = this.sqlite
      .prepare(`SELECT ${LEARNING_COLUMNS} FROM learning WHERE id IN (${normalizedIds.map(() => "?").join(", ")}) ORDER BY id ASC`)
      .all(...normalizedIds)
      .map(mapLearningRecord);
    const rowsById = new Map(rows.map((row) => [row.id, row]));

    return normalizedIds.flatMap((id) => {
      const learning = rowsById.get(id);
      return learning ? [learning] : [];
    });
  }

  listLearnings(filters: { search?: string; repo?: string; limit?: number; offset?: number } = {}): LearningRecord[] {
    if (filters.search) {
      const matches = this.searchLearnings({
        queries: [filters.search],
        ...(filters.repo ? { repos: [filters.repo] } : {}),
        ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
        ...(filters.offset !== undefined ? { offset: filters.offset } : {}),
      });
      return this.getLearningsById(matches.map((match) => match.id));
    }

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.repo) {
      clauses.push("repo = ?");
      params.push(filters.repo);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return this.sqlite
      .prepare(
        `SELECT ${LEARNING_COLUMNS}
           FROM learning ${where}
           ORDER BY updated_at DESC, id ASC
           LIMIT ? OFFSET ?`,
      )
      .all(...params, filters.limit ?? 50, filters.offset ?? 0)
      .map(mapLearningRecord);
  }
}
