import { newId } from "../../lib/ids.js";
import { isoNow } from "../../lib/time.js";
import type { HistoryRepo } from "../history-repo.js";
import type { HistoryRecord } from "../records.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

export class SqliteHistoryRepo implements HistoryRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  addHistoryStep(input: {
    stepId?: string;
    createdAt?: string;
    stage: string;
    issue: string;
    summary: string;
    repos?: Array<{ path: string; beforeSha: string; afterSha: string }>;
  }): string {
    const stepId = input.stepId ?? newId();
    const createdAt = input.createdAt ?? isoNow();
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare("INSERT INTO history_step(step_id, created_at, stage, issue, summary) VALUES (?, ?, ?, ?, ?)")
        .run(stepId, createdAt, input.stage, input.issue, input.summary);

      if (input.repos) {
        const insertRepo = this.sqlite.prepare(
          "INSERT INTO history_step_repo(step_id, position, path, before_sha, after_sha) VALUES (?, ?, ?, ?, ?)",
        );
        input.repos.forEach((repo, index) => {
          insertRepo.run(stepId, index + 1, repo.path, repo.beforeSha, repo.afterSha);
        });
      }
    })();
    return stepId;
  }

  listHistory(limit = 50): HistoryRecord[] {
    return this.sqlite
      .prepare(
        `SELECT h.step_id, h.created_at, h.stage, h.issue, h.summary,
                COALESCE(json_group_array(
                  CASE WHEN r.step_id IS NULL THEN NULL ELSE json_object('path', r.path, 'beforeSha', r.before_sha, 'afterSha', r.after_sha, 'position', r.position) END
                ), '[]') AS repos_json
           FROM history_step h
      LEFT JOIN history_step_repo r ON r.step_id = h.step_id
       GROUP BY h.step_id
       ORDER BY h.created_at DESC
       LIMIT ?`,
      )
      .all(limit)
      .map((row: unknown) => {
        const mapped = row as SqliteRow;
        return {
          stepId: String(mapped.step_id),
          createdAt: String(mapped.created_at),
          stage: String(mapped.stage),
          issue: String(mapped.issue),
          summary: String(mapped.summary),
          repos: JSON.parse(String(mapped.repos_json ?? "[]")).filter(Boolean),
        };
      });
  }
}
