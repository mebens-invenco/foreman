import type { Task } from "../domain/index.js";
import type { Embedder } from "../embeddings/embedder.js";
import { markdownSection } from "../prompts/template-renderer.js";
import type { LearningRecord, LearningRepo, LearningRetrievalProvenance } from "../repos/learning-repo.js";
import { searchLearningsWithHybridFallback } from "../retrieval/hybrid-learning-search.js";

/** Nobody asked for these learnings, so few enough that ignoring them stays cheap. */
export const RELEVANT_LEARNINGS_LIMIT = 5;

/** The whole section, guidance included — not just the entries. */
export const RELEVANT_LEARNINGS_TOKEN_BUDGET = 600;

/**
 * How close a learning must sit to the task text before it is worth pushing at an
 * agent who never asked for it. Raw cosine similarity, NOT the corpus-relative z
 * the cosine arm ranks on.
 *
 * z cannot express this bar, and gets it backwards. It asks "did this stand out
 * from the corpus", which against a homogeneous corpus is highest exactly where it
 * should be lowest: an on-topic query is broadly similar to everything, so nothing
 * stands out, while an off-topic query finds a lucky outlier in a low, tight
 * distribution. Against the live 143-learning corpus, "buy milk" scores z = 3.09
 * and a real foreman ticket scores z = 2.12 — a z floor would push learnings at
 * the shopping list and stay silent on the ticket.
 *
 * Similarity separates the two cleanly. Measured over 19 real tickets and 3
 * deliberately off-topic ones against the live corpus, the best hit per task:
 *
 *   real tickets     0.743 - 0.863
 *   off-topic tasks  0.519 - 0.656   (CSS padding, a k8s upgrade, buying milk)
 *
 * 0.70 is the middle of that empty band, not an edge of it: every value in roughly
 * [0.67, 0.74] rejects all three off-topic tasks and admits all 19 real ones, so
 * the midpoint is the choice furthest from either error. It admits ~2.8 entries per
 * real ticket. Do not read a second significant digit into it.
 *
 * CALIBRATED FOR `bge-small-en-v1.5` AND FOR A TITLE + DESCRIPTION QUERY. Cosine
 * scales are model-specific and shift with query length; changing either without
 * re-measuring this number silently changes what every attempt prompt is fed.
 */
export const INJECTION_SIMILARITY_FLOOR = 0.7;

const TOKENS_PER_CHARACTER = 0.25;

const estimateTokens = (text: string): number => Math.ceil(text.length * TOKENS_PER_CHARACTER);

/**
 * The relevance floor. A hit the cosine arm never proposed carries no similarity
 * at all, and "no evidence it is close" is not evidence that it is: it is floored
 * out rather than pushed on a bm25 rank alone.
 */
const clearsRelevanceFloor = (provenance: LearningRetrievalProvenance | undefined): boolean =>
  provenance?.bestCosineSimilarity != null && provenance.bestCosineSimilarity >= INJECTION_SIMILARITY_FLOOR;

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

const renderSection = (entries: readonly string[]): string =>
  markdownSection("Relevant Learnings", `${injectionGuidance}\n\n${entries.join("\n")}`);

/** Drops the lowest-ranked entries until the section fits; null when even one entry will not. */
const fitToTokenBudget = (entries: readonly string[]): string | null => {
  for (let count = entries.length; count > 0; count -= 1) {
    const section = renderSection(entries.slice(0, count));
    if (estimateTokens(section) <= RELEVANT_LEARNINGS_TOKEN_BUDGET) {
      return section;
    }
  }

  return null;
};

/**
 * The Relevant Learnings digest pushed into an attempt prompt, or null for
 * "inject nothing".
 *
 * Hybrid only. Push injection was sequenced after hybrid search precisely because
 * pushing FTS matches at an agent that did not ask for them injects noise, so a
 * fallback to bm25 — thin embedding coverage, an embedder that will not load,
 * an empty corpus — means no digest rather than a worse one.
 *
 * Worth knowing, because the name oversells it: on THIS path "hybrid" is very
 * nearly cosine alone. The bench's 0.676 recall@5 was measured on a planner's
 * several short queries; injection has one long one (a whole title + description),
 * and FTS ANDs every term of it, so bm25 matched in 1 of 54 bench cases. The
 * fusion is real, the coverage gate is real, and the bm25 arm is — here — almost
 * always silent, which leaves the floor below doing nearly all of the work.
 *
 * So `k = 5` is a cap, not a quota. Against the live corpus the fused window holds
 * 1-5 hits for a real ticket, and a homogeneous corpus of same-domain learnings has
 * only ever a handful genuinely worth pushing unasked. Injecting one is the system
 * working, not failing.
 *
 * Reading is not the same as being handed something: this path must not increment
 * `read_count`, or the "did the agent consult a learning" metric this feature
 * exists to move becomes 100% by construction, measuring only that injection ran.
 *
 * Nothing here may fail a render. A prompt without its digest is a slightly worse
 * prompt; a prompt that failed to render is a failed attempt. That includes the
 * defects `searchLearningsWithHybridFallback` deliberately re-throws — loud on the
 * CLI path where a human is waiting on the answer, swallowed on this one where
 * nobody asked. The defect still surfaces there; it just does not take an
 * unrelated attempt down with it here.
 */
export const injectRelevantLearnings = async (
  deps: { learnings: LearningRepo; embedder: Embedder; warn: (message: string) => void },
  input: { task: Task; repoKey: string },
): Promise<string | null> => {
  try {
    const query = `${input.task.title}\n${input.task.description}`.trim();
    if (query.length === 0) {
      return null;
    }

    const result = await searchLearningsWithHybridFallback(
      deps,
      { queries: [query], repos: [input.repoKey, "shared"], limit: RELEVANT_LEARNINGS_LIMIT },
      { incrementReadCount: false },
    );

    if (result.pipeline !== "hybrid") {
      deps.warn("no relevant-learnings digest injected: hybrid retrieval unavailable, and FTS matches are too weak to push");
      return null;
    }

    const ranked = result.learnings.filter((learning) => clearsRelevanceFloor(result.provenance.get(learning.id)));
    if (ranked.length === 0) {
      return null;
    }

    const bodies = deps.learnings.getLearningsByIds(
      ranked.map((learning) => learning.id),
      { incrementReadCount: false },
    );

    return fitToTokenBudget(bodies.map(renderEntry));
  } catch (error) {
    deps.warn(`no relevant-learnings digest injected: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};
