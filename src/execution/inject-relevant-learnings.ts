import type { Task } from "../domain/index.js";
import type { Embedder } from "../embeddings/embedder.js";
import { markdownSection } from "../prompts/template-renderer.js";
import type { LearningInjectionAction, LearningInjectionEventRepo } from "../repos/learning-injection-event-repo.js";
import type { LearningRecord, LearningRepo } from "../repos/learning-repo.js";
import { searchLearningsWithHybridFallback } from "../retrieval/hybrid-learning-search.js";

/** Injection is opt-in as a whole: a caller that wants no digest passes no deps. */
export type LearningInjectionDeps = {
  learnings: LearningRepo;
  embedder: Embedder;
  warn: (message: string) => void;
  telemetry: { events: LearningInjectionEventRepo; attemptId: string };
};

/** Nobody asked for these learnings, so few enough that ignoring them stays cheap. */
export const RELEVANT_LEARNINGS_LIMIT = 5;

/** The whole section, guidance included — not just the entries. */
export const RELEVANT_LEARNINGS_TOKEN_BUDGET = 600;

/**
 * How close a learning must sit to the task text before it is worth pushing at an
 * agent who never asked for it: raw cosine similarity against `injectionQueryText`,
 * NOT the corpus-relative z the cosine arm ranks on. z is a within-query bound and
 * inverts on a homogeneous corpus, so it cannot express this bar at all — the
 * measurements behind that are in `src/eval/retrieval/README.md`.
 *
 * The committed calibration separates real tasks (min 0.7163) from off-topic ones
 * (max 0.6564). 0.70 is deliberately NOT the midpoint of that band (0.6863 is): it
 * leans toward silence, because a wrong learning in an agent's context costs more
 * than a missing one. Both the separation and the lean are pinned, so the suite
 * accepts only (0.6863, 0.7163).
 *
 * Calibrated for `bge-small-en-v1.5` and for the `injectionQueryText` query shape —
 * a cosine scale belongs to the model and shifts with query length. Both couplings
 * are tripwired in `injection-similarity-calibration.test.ts`, which is the only
 * place this number can be re-derived: on its own it is unfalsifiable.
 */
export const INJECTION_SIMILARITY_FLOOR = 0.7;

/**
 * The exact text injection embeds for a task.
 *
 * Exported so the calibration fixture embeds what production embeds, the way
 * `learningEmbeddingText` does for the other side of the comparison. The floor is
 * calibrated for THIS query shape — a threshold measured against a different one
 * (the title alone, a truncated body) is a threshold for a different question.
 */
export const injectionQueryText = (task: { title: string; description: string }): string =>
  `${task.title}\n${task.description}`.trim();

const TOKENS_PER_CHARACTER = 0.25;

const estimateTokens = (text: string): number => Math.ceil(text.length * TOKENS_PER_CHARACTER);

/**
 * A learning paired with the similarity it cleared the floor on. The two travel
 * together because the telemetry below has to report the score the decision was
 * actually made on, and a similarity re-derived later — or defaulted when a
 * lookup misses — would be a number about a different question.
 */
type ScoredLearning = { learning: LearningRecord; cosineSimilarity: number };

const ruleLine = (content: string): string | null =>
  content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("**Rule:**")) ?? null;

// `{{workspace:name}}` and `{{session:action}}` are resolved by the template
// renderer's property pass, which runs over the injected context too.
const injectionGuidance = [
  "Retrieved for this task from the workspace learning store, most relevant first. Each entry is a digest, not the",
  "whole learning: read the full body with `foreman learnings get {{workspace:name}} --id <id> --caller {{session:action}}`",
  "before relying on one. If a learning materially influenced your work, return an `update` learning mutation carrying",
  "`markApplied: true` — that signal is how a learning earns its place here.",
].join("\n");

const renderEntry = (learning: LearningRecord): string => {
  const rule = ruleLine(learning.content);
  const heading = `- \`${learning.id}\` — ${learning.title}`;
  return rule ? `${heading}\n  ${rule}` : heading;
};

const renderSection = (injected: readonly ScoredLearning[]): string =>
  markdownSection("Relevant Learnings", `${injectionGuidance}\n\n${injected.map((hit) => renderEntry(hit.learning)).join("\n")}`);

/**
 * Drops the lowest-ranked entries until the section fits; empty when even one
 * entry will not. What it returns is what the agent was handed — the entries it
 * drops were retrieved but never injected, and must not be recorded as if they were.
 */
const fitToTokenBudget = (candidates: readonly ScoredLearning[]): readonly ScoredLearning[] => {
  for (let count = candidates.length; count > 0; count -= 1) {
    const injected = candidates.slice(0, count);
    if (estimateTokens(renderSection(injected)) <= RELEVANT_LEARNINGS_TOKEN_BUDGET) {
      return injected;
    }
  }

  return [];
};

/** Runs after the digest exists and cannot unmake it: a lost row must not cost an attempt its learnings. */
const recordInjection = (
  deps: LearningInjectionDeps,
  input: { task: Task; action: LearningInjectionAction },
  injected: readonly ScoredLearning[],
): void => {
  try {
    deps.telemetry.events.recordInjection({
      attemptId: deps.telemetry.attemptId,
      taskId: input.task.id,
      action: input.action,
      learnings: injected.map((hit, index) => ({
        learningId: hit.learning.id,
        rank: index + 1,
        cosineSimilarity: hit.cosineSimilarity,
      })),
    });
  } catch (error) {
    deps.warn(`relevant-learnings digest injected but not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * The Relevant Learnings digest pushed into an attempt prompt, or null for
 * "inject nothing". Four invariants, each pinned in
 * `__tests__/inject-relevant-learnings.test.ts`:
 *
 * - Hybrid only. A fallback to FTS — thin coverage, an embedder that will not load,
 *   an empty corpus — injects nothing: those matches carry no similarity to floor
 *   them on, and pushing them unmeasured is what this module exists to prevent.
 * - `RELEVANT_LEARNINGS_LIMIT` is a cap, not a quota. A corpus of same-domain
 *   learnings only ever holds a handful worth pushing unasked, so injecting one — or
 *   none — is the system working.
 * - Never increments `read_count`. Being handed something is not reading it, and the
 *   "did the agent consult a learning" metric this exists to move would otherwise
 *   read 100% by construction, measuring only that injection ran.
 * - Never fails a render. A prompt without its digest is slightly worse; a prompt
 *   that failed to render is a failed attempt. That includes the defects
 *   `searchLearningsWithHybridFallback` deliberately re-throws — loud on the CLI path
 *   where a human is waiting, swallowed here where nobody asked.
 */
export const injectRelevantLearnings = async (
  deps: LearningInjectionDeps,
  input: { task: Task; repoKey: string; action: LearningInjectionAction },
): Promise<string | null> => {
  try {
    const query = injectionQueryText(input.task);
    if (query.length === 0) {
      return null;
    }

    const result = await searchLearningsWithHybridFallback(
      deps,
      { queries: [query], repos: [input.repoKey, "shared"], limit: RELEVANT_LEARNINGS_LIMIT },
      { incrementReadCount: false },
    );

    // Not scored and found wanting — never scored at all. The `fts` result carries
    // no provenance, so the seam has no similarity to floor its matches on, and
    // pushing them unmeasured is the one thing this module exists to prevent.
    // Silent by design: `fallBackToFts` has already logged the actionable line for
    // a genuine degrade, and an empty store is not a degrade at all.
    if (result.pipeline !== "hybrid") {
      return null;
    }

    // The relevance floor. A hit the cosine arm never proposed carries no
    // similarity at all, and "no evidence it is close" is not evidence that it
    // is: it is floored out rather than pushed on a bm25 rank alone.
    const similarityById = new Map(
      result.learnings.flatMap((learning) => {
        const similarity = result.provenance.get(learning.id)?.bestCosineSimilarity;
        return similarity != null && similarity >= INJECTION_SIMILARITY_FLOOR ? [[learning.id, similarity] as const] : [];
      }),
    );
    if (similarityById.size === 0) {
      return null;
    }

    const bodies = deps.learnings.getLearningsByIds([...similarityById.keys()], { incrementReadCount: false });
    const candidates = bodies.flatMap((learning) => {
      const cosineSimilarity = similarityById.get(learning.id);
      return cosineSimilarity == null ? [] : [{ learning, cosineSimilarity }];
    });

    const injected = fitToTokenBudget(candidates);
    if (injected.length === 0) {
      return null;
    }

    const digest = renderSection(injected);
    recordInjection(deps, { task: input.task, action: input.action }, injected);
    return digest;
  } catch (error) {
    deps.warn(`no relevant-learnings digest injected: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};
