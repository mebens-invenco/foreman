import { ForemanError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { isoNow } from "../../lib/time.js";
import type { LearningRecord, LearningRepo } from "../learning-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

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

  listLearnings(filters: { search?: string; repo?: string; limit?: number; offset?: number } = {}): LearningRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.search) {
      clauses.push("rowid IN (SELECT rowid FROM learning_fts WHERE learning_fts MATCH ?)");
      params.push(filters.search);
    }

    if (filters.repo) {
      clauses.push("repo = ?");
      params.push(filters.repo);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return this.sqlite
      .prepare(
        `SELECT id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at
           FROM learning ${where}
          ORDER BY updated_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, filters.limit ?? 50, filters.offset ?? 0)
      .map((row: unknown) => {
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
      });
  }
}
