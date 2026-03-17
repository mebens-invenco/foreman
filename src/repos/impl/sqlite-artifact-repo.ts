import { isoNow } from "../../lib/time.js";
import { newId } from "../../lib/ids.js";
import type { ArtifactRecord, ArtifactRepo } from "../artifact-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

export class SqliteArtifactRepo implements ArtifactRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  createArtifact(input: {
    ownerType: "workspace" | "job" | "execution_attempt" | "scout_run";
    ownerId: string;
    artifactType: "log" | "rendered_prompt" | "parsed_result" | "plan_prompt" | "plan_context";
    relativePath: string;
    mediaType: string;
    sizeBytes: number;
    sha256?: string;
  }): void {
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO artifact(
          id, owner_type, owner_id, artifact_type, relative_path, media_type, size_bytes, sha256, created_at
        ) VALUES (
          COALESCE((SELECT id FROM artifact WHERE relative_path = ?), ?), ?, ?, ?, ?, ?, ?, ?, ?
        )`,
      )
      .run(
        input.relativePath,
        newId(),
        input.ownerType,
        input.ownerId,
        input.artifactType,
        input.relativePath,
        input.mediaType,
        input.sizeBytes,
        input.sha256 ?? null,
        isoNow(),
      );
  }

  listArtifacts(ownerType?: string, ownerId?: string): ArtifactRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (ownerType) {
      clauses.push("owner_type = ?");
      params.push(ownerType);
    }
    if (ownerId) {
      clauses.push("owner_id = ?");
      params.push(ownerId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.sqlite
      .prepare(
        `SELECT id, owner_type, owner_id, artifact_type, relative_path, media_type, size_bytes, sha256, created_at
           FROM artifact ${where} ORDER BY created_at DESC`,
      )
      .all(...params)
      .map((row: unknown) => {
        const mapped = row as SqliteRow;
        return {
          id: String(mapped.id),
          ownerType: mapped.owner_type as ArtifactRecord["ownerType"],
          ownerId: String(mapped.owner_id),
          artifactType: mapped.artifact_type as ArtifactRecord["artifactType"],
          relativePath: String(mapped.relative_path),
          mediaType: String(mapped.media_type),
          sizeBytes: Number(mapped.size_bytes),
          sha256: (mapped.sha256 as string | null) ?? null,
          createdAt: String(mapped.created_at),
        };
      });
  }
}
