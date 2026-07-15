import { cosineSimilarity } from "../../retrieval/cosine-similarity.js";
import { ForemanError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { isoNow } from "../../lib/time.js";
import { assertRankableVector, isRankableVector } from "../../embeddings/rankable-vector.js";
import { selectCosineCandidates, selectSimilarCandidates } from "../../retrieval/cosine-candidates.js";
import { fuseByReciprocalRank } from "../../retrieval/reciprocal-rank-fusion.js";
import type {
  CoveredHybridSearch,
  CoveredSimilarLearnings,
  LearningEmbeddingRecord,
  LearningEmbeddingUpsert,
  LearningReadOptions,
  LearningRecord,
  LearningRepo,
  LearningRetrievalProvenance,
  LearningSearchRecord,
} from "../learning-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

const LEARNING_COLUMNS =
  "id, title, repo, tags, confidence, content, applied_count, read_count, duplicate_of, source_task_id, archived_at, created_at, updated_at";

const toNullableString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

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
    duplicateOf: toNullableString(mapped.duplicate_of),
    sourceTaskId: toNullableString(mapped.source_task_id),
    archivedAt: toNullableString(mapped.archived_at),
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

/**
 * Whether a stored row can be decoded into the `dims` float32s it claims — asked
 * of the RAW row, before `fromVectorBlob` touches it.
 *
 * A blob whose byte length is not a multiple of 4 makes `new Float32Array` throw,
 * and the repair path reads through here: a truncated blob would take
 * `backfill-embeddings` down with it rather than being re-embedded by it. Checking
 * the byte count also subsumes "the row claims a width it does not have" — a blob
 * is exactly `dims` floats wide or it is not this row's vector at all.
 */
const isDecodableVectorRow = (row: SqliteRow): boolean =>
  (row.vector as Buffer).byteLength === Number(row.dims) * 4;

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

  // Archived learnings leave every retrieval surface, so their vectors surface in
  // none of these reads either. This keeps the coverage gate honest: an archived
  // row is out of the numerator here exactly as it is out of `countLearnings`'
  // denominator, and out of the `current` set `listLearningIdsMissingEmbedding`
  // subtracts — so it can never be counted as missing and owed a backfill.
  const clauses: string[] = ["learning.archived_at IS NULL"];
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

type HybridQuery = { text: string; vector: Float32Array };

// Zip before normalizing. `normalizeFilterValues` trims and de-duplicates, so
// normalizing the query texts alone would shift vectors onto the wrong queries
// the moment a caller passes a blank or repeated query.
const resolveHybridQueries = (
  filters: { queries?: string[] },
  queryEmbedding: { vectors: readonly Float32Array[] },
): HybridQuery[] => {
  const rawQueries = filters.queries ?? [];
  if (queryEmbedding.vectors.length !== rawQueries.length) {
    throw new ForemanError(
      "hybrid_query_vector_mismatch",
      `Received ${queryEmbedding.vectors.length} query vectors for ${rawQueries.length} queries`,
      500,
    );
  }

  const seen = new Set<string>();
  const queries: HybridQuery[] = [];
  rawQueries.forEach((rawQuery, index) => {
    const text = rawQuery.trim();
    if (text.length === 0 || seen.has(text)) {
      return;
    }

    seen.add(text);
    queries.push({ text, vector: queryEmbedding.vectors[index]! });
  });

  // Falling through to `searchLearnings` here would hand back its recency
  // listing — rows scored `0.0` that never met the fusion — which the caller
  // would then label hybrid. The CLI already rejects a missing `--query`, so an
  // all-blank query list is a caller bug, not a mode to degrade around.
  if (queries.length === 0) {
    throw new ForemanError("hybrid_query_missing", "searchLearningsHybrid requires at least one non-blank query", 500);
  }

  return queries;
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
    sourceTaskId?: string;
    duplicateOf?: string;
  }): string {
    const id = input.id ?? newId();
    this.sqlite
      .prepare(
        "INSERT INTO learning(id, title, repo, tags, confidence, content, applied_count, read_count, duplicate_of, source_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.title,
        input.repo,
        JSON.stringify(input.tags),
        input.confidence,
        input.content,
        input.duplicateOf ?? null,
        input.sourceTaskId ?? null,
        isoNow(),
        isoNow(),
      );
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

    // Clearing `archived_at` un-archives: an update is fresh evidence the learning
    // is worth carrying, so it revives an archived row rather than editing a
    // shelved one. The applier's freshness guard re-embeds if the content changed.
    this.sqlite
      .prepare(
        `UPDATE learning
            SET title = ?, repo = ?, tags = ?, confidence = ?, content = ?, applied_count = ?, archived_at = NULL, updated_at = ?
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

  archiveLearning(id: string): void {
    this.setArchivedAt(id, isoNow());
  }

  unarchiveLearning(id: string): void {
    this.setArchivedAt(id, null);
  }

  // One transaction over the whole batch: either every loser gains its
  // `duplicate_of` link and leaves retrieval, or none does. A partial apply would
  // strand a transitive-chain loser (see the interface doc), so an unknown id
  // throws and rolls the batch back rather than committing the losers before it.
  // Each row is existence-checked like `setArchivedAt`. `updated_at` is left alone
  // and the `learning_touch_updated_at` trigger bumps it — harmless, as an archived
  // row is out of every recency-ordered surface. The `duplicate_of` FK is the
  // backstop that a survivor id actually exists.
  flagAndArchiveDuplicates(pairs: readonly { id: string; duplicateOf: string }[]): void {
    if (pairs.length === 0) {
      return;
    }

    const exists = this.sqlite.prepare("SELECT id FROM learning WHERE id = ?");
    const flagAndArchive = this.sqlite.prepare("UPDATE learning SET duplicate_of = ?, archived_at = ? WHERE id = ?");
    const archivedAt = isoNow();

    this.sqlite.transaction(() => {
      for (const pair of pairs) {
        if (!exists.get(pair.id)) {
          throw new ForemanError("learning_not_found", `Learning not found: ${pair.id}`, 404);
        }
        flagAndArchive.run(pair.duplicateOf, archivedAt, pair.id);
      }
    })();
  }

  // Existence-checked like `updateLearning`, so an unknown id is a caller error
  // rather than a silent no-op. The `learning_touch_updated_at` trigger bumps
  // `updated_at` here (this write leaves it untouched) — expected and harmless:
  // embedding freshness keys on the title/content snapshot, not `updated_at`, and
  // archived rows are excluded from every recency-ordered retrieval surface.
  private setArchivedAt(id: string, archivedAt: string | null): void {
    const existing = this.sqlite.prepare("SELECT id FROM learning WHERE id = ?").get(id) as SqliteRow | undefined;
    if (!existing) {
      throw new ForemanError("learning_not_found", `Learning not found: ${id}`, 404);
    }

    this.sqlite.prepare("UPDATE learning SET archived_at = ? WHERE id = ?").run(archivedAt, id);
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
      const repoClause = repos.length > 0 ? ` AND repo IN (${repos.map(() => "?").join(", ")})` : "";
      const learnings = this.sqlite
        .prepare(
          `SELECT id, title, repo, tags, confidence, created_at, updated_at, 0.0 AS score
             FROM learning
            WHERE archived_at IS NULL${repoClause}
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

    // Archived rows are still indexed in `learning_fts` (archiving does not
    // reindex), so they can match; drop them here at the join, before the JS sort
    // and slice so the page window counts only rows that survive the filter.
    const repoWhere = repos.length > 0 ? ` AND repo IN (${repos.map(() => "?").join(", ")})` : "";
    const rows = this.sqlite
      .prepare(
        `SELECT rowid, id, title, repo, tags, confidence, created_at, updated_at
           FROM learning
          WHERE rowid IN (${rowIds.map(() => "?").join(", ")}) AND archived_at IS NULL${repoWhere}`,
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
    const queries = resolveHybridQueries(filters, queryEmbedding);
    const embeddings = this.getCurrentLearningEmbeddings({
      repos: normalizeFilterValues(filters.repos),
      model: queryEmbedding.model,
    });
    const { learnings } = this.rankLearningsHybrid(queries, filters, embeddings);

    if (options.incrementReadCount) {
      this.incrementReadCount(learnings.map((learning) => learning.id));
    }

    return learnings;
  }

  searchLearningsHybridCovered(
    filters: { queries?: string[]; repos?: string[]; limit?: number; offset?: number },
    queryEmbedding: { model: string; vectors: readonly Float32Array[] },
    gate: { minCoverage: number },
    options: LearningReadOptions = {},
  ): CoveredHybridSearch {
    // Validated before the snapshot opens, so a caller bug surfaces as itself
    // rather than as a coverage miss.
    const queries = resolveHybridQueries(filters, queryEmbedding);
    const repos = normalizeFilterValues(filters.repos);
    const scope = repos.length > 0 ? { repos } : {};

    // The decision and the ranking it authorizes read ONE snapshot. Left as two
    // independent reads, the live server — a separate process on the same WAL
    // file — can commit a corpus change in between, and the gate would then be
    // enforced against a corpus that no longer exists.
    const result = this.sqlite.transaction((): CoveredHybridSearch => {
      const learningCount = this.countLearnings(scope);
      // One read, shared by the gate and the ranking it authorizes. They now see
      // not merely the same snapshot but literally the same vectors, so the corpus
      // the gate measured is the corpus the fusion ranks.
      const embeddings = this.getCurrentLearningEmbeddings({ ...scope, model: queryEmbedding.model });
      if (learningCount === 0 || embeddings.length / learningCount < gate.minCoverage) {
        return { covered: false, learningCount, embeddingCount: embeddings.length };
      }

      return { covered: true, ...this.rankLearningsHybrid(queries, filters, embeddings) };
    })();

    // Outside the snapshot: a read counter is telemetry about what came back, not
    // part of the view the ranking was computed from. Writing inside a deferred
    // read transaction would also risk SQLITE_BUSY_SNAPSHOT against a live writer.
    if (result.covered && options.incrementReadCount) {
      this.incrementReadCount(result.learnings.map((learning) => learning.id));
    }

    return result;
  }

  selectSimilarLearningsCovered(
    filters: { repos?: string[]; limit: number },
    queryEmbedding: { model: string; vector: Float32Array },
    gate: { minCoverage: number; minSimilarity: number },
  ): CoveredSimilarLearnings {
    const repos = normalizeFilterValues(filters.repos);
    const scope = repos.length > 0 ? { repos } : {};

    // Gate, selection and bodies read ONE snapshot, for the reason
    // `searchLearningsHybridCovered` does: the serve loop is a separate process on
    // the same WAL file, so left as independent reads the gate could authorize a
    // corpus that no longer exists by the time it is ranked.
    return this.sqlite.transaction((): CoveredSimilarLearnings => {
      const learningCount = this.countLearnings(scope);
      const embeddings = this.getCurrentLearningEmbeddings({ ...scope, model: queryEmbedding.model });
      if (learningCount === 0 || embeddings.length / learningCount < gate.minCoverage) {
        return { covered: false, learningCount, embeddingCount: embeddings.length };
      }

      const candidates = selectSimilarCandidates(queryEmbedding.vector, embeddings, {
        minSimilarity: gate.minSimilarity,
        limit: filters.limit,
      });

      // Rebuilt in candidate order, which is similarity order. Keying the fetch by id
      // and walking `candidates` means the fetch's own ordering is not relied on at
      // all, and each learning is paired with the similarity it was admitted on.
      const bodies = new Map(this.getLearningsByIds(candidates.map((candidate) => candidate.id)).map((row) => [row.id, row]));
      return {
        covered: true,
        learnings: candidates.flatMap((candidate) => {
          const learning = bodies.get(candidate.id);
          return learning ? [{ learning, similarity: candidate.similarity }] : [];
        }),
      };
    })();
  }

  private rankLearningsHybrid(
    queries: readonly HybridQuery[],
    filters: { repos?: string[]; limit?: number; offset?: number },
    embeddings: readonly LearningEmbeddingRecord[],
  ): { learnings: LearningSearchRecord[]; provenance: Map<string, LearningRetrievalProvenance> } {
    const repos = normalizeFilterValues(filters.repos);
    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;

    // The whole in-scope corpus, not just the bm25 matches: cosine ranks every
    // candidate, which is the entire point of the fusion. Bounded by the corpus
    // (hundreds of rows), so a full scan costs microseconds. Archived rows are
    // excluded here, so they enter neither the bm25 rowid→id map nor the row
    // bodies — and the cosine arm never sees them, since `embeddings` came from
    // `getCurrentLearningEmbeddings`, which excludes them too.
    const repoClause = repos.length > 0 ? ` AND repo IN (${repos.map(() => "?").join(", ")})` : "";
    const inScopeRows = this.sqlite
      .prepare(
        `SELECT rowid, id, title, repo, tags, confidence, created_at, updated_at
           FROM learning
          WHERE archived_at IS NULL${repoClause}`,
      )
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

    // `embeddings` is the current vector space, read once by the caller and reused
    // across queries. A learning with no vector, one whose text has moved on since
    // it was embedded, or one whose vector nothing can rank simply never enters the
    // cosine list; its bm25 rank still counts. `selectCosineCandidates` bounds that
    // list rather than ranking the whole corpus, so an empty result stays possible
    // and bm25 hits are not displaced by arbitrary near-neighbours.
    //
    // Provenance is recorded off the same two lists the fusion reads, never off its
    // output: it observes the ranking, it does not participate in it.
    // Each learning's best showing across queries, mirroring how the fused score
    // itself keeps each learning's best.
    const bestScores = new Map<string, number>();
    const bestSimilarities = new Map<string, number>();

    for (const query of queries) {
      const bm25Ranking = rankByBm25(query.text);
      const cosineCandidates = selectCosineCandidates(query.vector, embeddings);

      for (const candidate of cosineCandidates) {
        const previous = bestSimilarities.get(candidate.id);
        if (previous === undefined || candidate.similarity > previous) {
          bestSimilarities.set(candidate.id, candidate.similarity);
        }
      }

      // The fusion still reads two ordered id lists, exactly as before: the
      // similarity rides alongside the cosine ranking, it does not enter it.
      for (const [id, score] of fuseByReciprocalRank([bm25Ranking, cosineCandidates.map((candidate) => candidate.id)])) {
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

    // Narrowed to what actually came back, so the map means "provenance of these
    // results" rather than of every candidate the fusion considered and dropped.
    return {
      learnings,
      provenance: new Map(
        learnings.map((learning) => [learning.id, { bestCosineSimilarity: bestSimilarities.get(learning.id) ?? null }] as const),
      ),
    };
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

  listLearnings(
    filters: { search?: string; repo?: string; limit?: number; offset?: number; includeArchived?: boolean } = {},
  ): LearningRecord[] {
    if (filters.search) {
      // Search is a retrieval surface: `searchLearnings` already hides archived
      // rows, so `includeArchived` has no say on this path — a text query never
      // surfaces an archived learning.
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

    // The browse path: the UI/HTTP surface passes `includeArchived` to show
    // archived rows (badged); every prompt-facing caller leaves it false.
    if (!filters.includeArchived) {
      clauses.push("archived_at IS NULL");
    }

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
    // Archived rows are out of the coverage gate's denominator exactly as their
    // vectors are out of `getCurrentLearningEmbeddings`' numerator — count them in
    // one but not the other and the gate would read a coverage it cannot honour.
    const repoClause = repos.length > 0 ? ` AND repo IN (${repos.map(() => "?").join(", ")})` : "";
    const row = this.sqlite
      .prepare(`SELECT COUNT(*) AS count FROM learning WHERE archived_at IS NULL${repoClause}`)
      .get(...repos) as SqliteRow;

    return Number(row.count);
  }

  upsertLearningEmbedding(input: LearningEmbeddingUpsert): boolean {
    // The single choke point every vector reaches the database through — backfill,
    // worker applier, bench alike — so this is where an unrankable one has to be
    // stopped. Persisted, it is a poison pill rather than a bad row: its text
    // snapshot still matches its learning, so `listLearningIdsMissingEmbedding`
    // calls it current and `backfill-embeddings` skips it, while every search over
    // that scope throws. The refusal in `cosineSimilarity` is a backstop; this is
    // the guard.
    assertRankableVector(input.vector);

    // `dims` is metadata ABOUT the blob, persisted beside it and used to decode
    // it. A row allowed to claim a width it does not have is a row that lies about
    // itself, which is the same reason the embedder port checks its own width.
    if (input.dims !== input.vector.length) {
      throw new ForemanError(
        "embedding_dims_mismatch",
        `Cannot store a ${input.vector.length}-dim vector as ${input.dims} dims`,
        500,
      );
    }

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
    // Missing is the COMPLEMENT of current, by construction — absent, from another
    // model, embedded from other text, or carrying a vector nothing can rank.
    // Deriving it from the same read is what makes `backfill-embeddings` the true
    // remedy: a vector corrupted after it was written is re-embedded rather than
    // left for hand-written SQL. Two separate predicates would be two things to
    // keep in agreement, which is exactly how the timestamp rule drifted away from
    // the applier's in the first place.
    const current = new Set(this.getCurrentLearningEmbeddings({ model }).map((embedding) => embedding.learningId));

    // Archived learnings need no vector: excluded from the id list here exactly as
    // they are from `getCurrentLearningEmbeddings`, so one can never be reported as
    // missing and let `backfill-embeddings` claim or block work on a shelved row.
    return this.sqlite
      .prepare("SELECT id FROM learning WHERE archived_at IS NULL ORDER BY id ASC")
      .all()
      .map((row) => String((row as SqliteRow).id))
      .filter((id) => !current.has(id));
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

    return (
      this.sqlite
        .prepare(
          `SELECT learning_embedding.learning_id, learning_embedding.model, learning_embedding.dims, learning_embedding.vector
             FROM learning_embedding
             JOIN learning ON learning.id = learning_embedding.learning_id
             ${where}
            ORDER BY learning_embedding.learning_id ASC`,
        )
        .all(...params)
        // Both checks reject a row the write boundaries would never have written,
        // so a row failing either was corrupted after the fact. Treating it as one
        // the backfill owes (see `listLearningIdsMissingEmbedding`) is what makes
        // it repairable by the command the operator is actually told to run.
        // Undecodable first, and on the raw row: decoding it would throw, and take
        // that repair path down with it.
        .filter((row) => isDecodableVectorRow(row as SqliteRow))
        .map(mapLearningEmbeddingRecord)
        .filter((embedding) => isRankableVector(embedding.vector))
    );
  }

  countCurrentLearningEmbeddings(filters: { repos?: string[]; model: string }): number {
    // Derived from the same read rather than counted in SQL, so the count and the
    // rows can never disagree about what "current" means. Decoding a few hundred
    // vectors costs microseconds; a gate that counts a vector the ranking then
    // refuses to use costs a wrong answer.
    return this.getCurrentLearningEmbeddings(filters).length;
  }

  nearestLearningEmbedding(
    vector: Float32Array,
    filters: { model: string; repos?: string[] },
  ): { learningId: string; similarity: number } | undefined {
    let nearest: { learningId: string; similarity: number } | undefined;

    // Current vectors only: a stale vector describes text the learning no
    // longer carries, so a match against it is not evidence of a duplicate.
    // `getCurrentLearningEmbeddings` orders by learning id, and a strict `>`
    // keeps the first of any tie, so equally-similar neighbours resolve
    // deterministically.
    for (const candidate of this.getCurrentLearningEmbeddings(filters)) {
      // Filtering by model should make every candidate the same width, so a
      // mismatch is a corrupt row. Skip it rather than letting cosineSimilarity
      // throw: one bad row would otherwise abort the whole scan, and since
      // `listLearningIdsMissingEmbedding` cannot see a same-model wrong-width
      // row, backfill would never repair it -- silently disabling near-duplicate
      // detection for this scope forever.
      if (candidate.vector.length !== vector.length) {
        continue;
      }

      const similarity = cosineSimilarity(vector, candidate.vector);
      // A NaN component yields a NaN similarity, and every `>` against NaN is
      // false -- so a malformed first candidate would install itself as
      // `nearest` and no later one could ever displace it, killing detection for
      // the whole scope. Same corrupt-row reasoning as the width skip above.
      if (!Number.isFinite(similarity)) {
        continue;
      }

      if (!nearest || similarity > nearest.similarity) {
        nearest = { learningId: candidate.learningId, similarity };
      }
    }

    return nearest;
  }
}
