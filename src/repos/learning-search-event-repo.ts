import type { RetrievalPipeline } from "../retrieval/retrieval-pipeline.js";
import type { LearningUsageSource } from "./learning-usage-repo.js";

export type LearningSearchEventKind = "search" | "get";

/**
 * One recorded `foreman learnings search` / `learnings get` invocation. The
 * `zeroHit` flag is derived from `hitIds` at write time, so it can never
 * disagree with what actually came back.
 */
export type LearningSearchEventInput = {
  kind: LearningSearchEventKind;
  /** Optional pipeline stage that issued the query (e.g. `plan`, `execution`). */
  caller?: string | null;
  /** Full query strings for a `search`; empty for a `get`. */
  queries?: string[];
  /** Repo scopes the caller restricted the query to. */
  repos?: string[];
  /** Ids the caller asked for on a `get`; empty for a `search`. */
  requestedIds?: string[];
  /** Learning ids that came back. */
  hitIds?: string[];
  /**
   * Relevance scores aligned with `hitIds` (search only; empty for `get`).
   * Only comparable within one `pipeline`: hybrid fuses ranks (higher is better),
   * fts reports raw bm25 (more negative is better).
   */
  hitScores?: number[];
  /** Retriever that answered a `search`; null for a `get`. */
  pipeline?: RetrievalPipeline | null;
  /**
   * The attempt this query ran inside, taken from the runner env. Absent for
   * ad-hoc human CLI use, which stamps NULL and is excluded from every
   * distinct-task count — a query no task caused cannot evidence a task's use.
   */
  source?: LearningUsageSource;
};

export type LearningSearchEventRecord = {
  id: string;
  createdAt: string;
  kind: LearningSearchEventKind;
  caller: string | null;
  queries: string[];
  repos: string[];
  requestedIds: string[];
  hitIds: string[];
  hitScores: number[];
  zeroHit: boolean;
  pipeline: RetrievalPipeline | null;
  attemptId: string | null;
  taskId: string | null;
};

export type LearningSearchEventFilters = {
  kind?: LearningSearchEventKind;
  caller?: string;
  zeroHit?: boolean;
  limit?: number;
  offset?: number;
};

export interface LearningSearchEventRepo {
  recordEvent(input: LearningSearchEventInput): string;
  listEvents(filters?: LearningSearchEventFilters): LearningSearchEventRecord[];
}
