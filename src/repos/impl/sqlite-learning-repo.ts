import { ForemanError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { isoNow } from "../../lib/time.js";
import { selectCosineCandidates } from "../../retrieval/cosine-candidates.js";
import { fuseByReciprocalRank } from "../../retrieval/reciprocal-rank-fusion.js";
import type {
  LearningEmbeddingRecord,
  LearningEmbeddingUpsert,
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

// Shared by every `learning_embedding` reader so a scope means the same thing
// whether it is being counted or decoded.
//
// `currentOnly` adds the freshness half of `listLearningIdsMissingEmbedding`'s
// definition (`missing = absent OR other model OR embedded from other text`), so
// callers that must agree with `backfill-embeddings` about what "embedded" means
// cannot drift from it.
//
// Keyed on the text, never on `learning.updated_at`: that timestamp moves on
// metadata-only writes (tags, confidence, `applied_count`), which leave the
// vector perfectly valid. `IS` rather than `=` so the NULL snapshot on a row
// this migration left stale reads as a mismatch instead of as unknown.
const learningEmbeddingFilter = (
  filters: { repos?: string[]; model?: string },
  options: { currentOnly?: boolean } = {},
): { where: string; params: unknown[] } => {
  const repos = normalizeFilterValues(filters.repos);
  const model = filters.model?.trim();

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (repos.length > 0) {
    clauses.push(`learning.repo IN (${repos.map(() => "?").join(", ")})`);
    params.push(...repos);
  }
  if (model) {
    clauses.push("learning_embedding.model = ?");
    params.push(model);
  }
  if (options.currentOnly) {
    clauses.push("learning_embedding.embedded_title IS learning.title");
    clauses.push("learning_embedding.embedded_content IS learning.content");
  }

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
};

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

  searchLearningsHybrid(
    filters: { queries?: string[]; repos?: string[]; limit?: number; offset?: number },
    queryEmbedding: { model: string; vectors: readonly Float32Array[] },
    options: LearningReadOptions = {},
  ): LearningSearchRecord[] {
    const rawQueries = filters.queries ?? [];
    if (queryEmbedding.vectors.length !== rawQueries.length) {
      throw new ForemanError(
        "hybrid_query_vector_mismatch",
        `Received ${queryEmbedding.vectors.length} query vectors for ${rawQueries.length} queries`,
        500,
      );
    }

    // Zip before normalizing. `normalizeFilterValues` trims and de-duplicates,
    // so normalizing the query texts alone would shift vectors onto the wrong
    // queries the moment a caller passes a blank or repeated query.
    const seenQueries = new Set<string>();
    const queries: { text: string; vector: Float32Array }[] = [];
    rawQueries.forEach((rawQuery, index) => {
      const text = rawQuery.trim();
      if (text.length === 0 || seenQueries.has(text)) {
        return;
      }

      seenQueries.add(text);
      queries.push({ text, vector: queryEmbedding.vectors[index]! });
    });

    // Delegating to `searchLearnings` here would take its listing branch and hand
    // back recency-ordered rows scored `0.0` — records that never met the fusion,
    // labelled hybrid by the caller. The CLI already rejects a missing `--query`,
    // so an all-blank query list is a caller bug, not a mode to degrade around.
    if (queries.length === 0) {
      throw new ForemanError("hybrid_query_missing", "searchLearningsHybrid requires at least one non-blank query", 500);
    }

    const repos = normalizeFilterValues(filters.repos);
    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;

    // The whole in-scope corpus, not just the bm25 matches: cosine ranks every
    // candidate, which is the entire point of the fusion. Bounded by the corpus
    // (hundreds of rows), so a full scan costs microseconds.
    const repoWhere = repos.length > 0 ? `WHERE repo IN (${repos.map(() => "?").join(", ")})` : "";
    const inScopeRows = this.sqlite
      .prepare(`SELECT rowid, id, title, repo, tags, confidence, created_at, updated_at FROM learning ${repoWhere}`)
      .all(...repos) as SqliteRow[];
    const idsByRowId = new Map(inScopeRows.map((row) => [Number(row.rowid), String(row.id)]));
    const rowsById = new Map(inScopeRows.map((row) => [String(row.id), row]));

    const selectMatches = this.sqlite.prepare("SELECT rowid, bm25(learning_fts) AS score FROM learning_fts WHERE learning_fts MATCH ?");
    // FTS5 returns MATCH rows in unspecified order, so rank them here. bm25 is
    // negative and more negative is better; ties break on id for determinism.
    const rankByBm25 = (query: string): string[] =>
      (selectMatches.all(toSafeFtsQuery(query)) as SqliteRow[])
        .flatMap((row) => {
          const id = idsByRowId.get(Number(row.rowid));
          return id === undefined ? [] : [{ id, score: Number(row.score) }];
        })
        .sort((left, right) => left.score - right.score || left.id.localeCompare(right.id))
        .map((candidate) => candidate.id);

    // One read of the vector space, reused across queries. A learning with no
    // vector, or one whose text has moved on since it was embedded, simply never
    // enters the cosine list; its bm25 rank still counts.
    // `selectCosineCandidates` bounds that list rather than ranking the whole
    // corpus, so an empty result stays possible and bm25 hits are not displaced
    // by arbitrary near-neighbours.
    const embeddings = this.getCurrentLearningEmbeddings({ repos, model: queryEmbedding.model });

    const bestScores = new Map<string, number>();
    for (const query of queries) {
      for (const [id, score] of fuseByReciprocalRank([rankByBm25(query.text), selectCosineCandidates(query.vector, embeddings)])) {
        const previousScore = bestScores.get(id);
        if (previousScore === undefined || score > previousScore) {
          bestScores.set(id, score);
        }
      }
    }

    const learnings = Array.from(bestScores, ([id, score]) => ({ row: rowsById.get(id), score }))
      .flatMap(({ row, score }) => (row ? [mapLearningSearchRecord({ ...row, score })] : []))
      .sort((left, right) => {
        // Fused score is a relevance score: descending, unlike raw bm25.
        if (left.score !== right.score) {
          return right.score - left.score;
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

  countLearnings(filters: { repos?: string[] } = {}): number {
    const repos = normalizeFilterValues(filters.repos);
    const where = repos.length > 0 ? `WHERE repo IN (${repos.map(() => "?").join(", ")})` : "";
    const row = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM learning ${where}`).get(...repos) as SqliteRow;

    return Number(row.count);
  }

  upsertLearningEmbedding(input: LearningEmbeddingUpsert): boolean {
    // Selecting the row rather than VALUES makes the guard and the write one
    // statement: a learning edited between an embed and its write yields no
    // source row, so the stale vector is dropped instead of being stamped
    // newer than the text it no longer describes.
    // The snapshot columns are selected from the very row the guard matched, so
    // they cannot disagree with the text this vector was computed from — that is
    // what makes them a sound key for freshness everywhere else.
    const result = this.sqlite
      .prepare(
        `INSERT INTO learning_embedding(learning_id, model, dims, vector, updated_at, embedded_title, embedded_content)
              SELECT learning.id, ?, ?, ?, ?, learning.title, learning.content
                FROM learning
               WHERE learning.id = ?
                 AND learning.title = ?
                 AND learning.content = ?
         ON CONFLICT(learning_id) DO UPDATE
                 SET model = excluded.model,
                     dims = excluded.dims,
                     vector = excluded.vector,
                     updated_at = excluded.updated_at,
                     embedded_title = excluded.embedded_title,
                     embedded_content = excluded.embedded_content`,
      )
      .run(
        input.model,
        input.dims,
        toVectorBlob(input.vector),
        isoNow(),
        input.learningId,
        input.embeddedTitle,
        input.embeddedContent,
      );

    return result.changes > 0;
  }

  listLearningIdsMissingEmbedding(model: string): string[] {
    // Text, not `updated_at`: re-embedding a learning because someone bumped its
    // `applied_count` burns the model on text that never changed, and — since
    // the coverage gate reads the same rule — would take hybrid retrieval down
    // with it. `worker-result-applier` has always compared the text this way.
    return this.sqlite
      .prepare(
        `SELECT learning.id AS id
           FROM learning
           LEFT JOIN learning_embedding ON learning_embedding.learning_id = learning.id
          WHERE learning_embedding.learning_id IS NULL
             OR learning_embedding.model != ?
             OR learning_embedding.embedded_title IS NOT learning.title
             OR learning_embedding.embedded_content IS NOT learning.content
          ORDER BY learning.id ASC`,
      )
      .all(model)
      .map((row) => String((row as SqliteRow).id));
  }

  getLearningEmbeddings(filters: { repos?: string[]; model?: string } = {}): LearningEmbeddingRecord[] {
    const { where, params } = learningEmbeddingFilter(filters);

    return this.sqlite
      .prepare(
        `SELECT learning_embedding.learning_id, learning_embedding.model, learning_embedding.dims, learning_embedding.vector
           FROM learning_embedding
           JOIN learning ON learning.id = learning_embedding.learning_id
           ${where}
          ORDER BY learning_embedding.learning_id ASC`,
      )
      .all(...params)
      .map(mapLearningEmbeddingRecord);
  }

  getCurrentLearningEmbeddings(filters: { repos?: string[]; model: string }): LearningEmbeddingRecord[] {
    const { where, params } = learningEmbeddingFilter(filters, { currentOnly: true });

    return this.sqlite
      .prepare(
        `SELECT learning_embedding.learning_id, learning_embedding.model, learning_embedding.dims, learning_embedding.vector
           FROM learning_embedding
           JOIN learning ON learning.id = learning_embedding.learning_id
           ${where}
          ORDER BY learning_embedding.learning_id ASC`,
      )
      .all(...params)
      .map(mapLearningEmbeddingRecord);
  }

  countCurrentLearningEmbeddings(filters: { repos?: string[]; model: string }): number {
    const { where, params } = learningEmbeddingFilter(filters, { currentOnly: true });

    const row = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS count
           FROM learning_embedding
           JOIN learning ON learning.id = learning_embedding.learning_id
           ${where}`,
      )
      .get(...params) as SqliteRow;

    return Number(row.count);
  }
}
