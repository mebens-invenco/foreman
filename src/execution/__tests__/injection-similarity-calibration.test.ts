import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createEmbedder } from "../../embeddings/create-embedder.js";
import { corpusEmbeddingDigest } from "../../orchestration/__tests__/corpus-embedding-digest.js";
import { selectCosineCandidates, selectSimilarCandidates } from "../../retrieval/cosine-candidates.js";
import { cosineSimilarity } from "../../retrieval/cosine-similarity.js";
import { testProjectRoot } from "../../test-support/helpers.js";
import { INJECTION_SIMILARITY_FLOOR, RELEVANT_LEARNINGS_LIMIT } from "../inject-relevant-learnings.js";
import { injectionCalibrationDigest, type CalibrationQuery } from "./injection-calibration-digest.js";

/**
 * Calibrates INJECTION_SIMILARITY_FLOOR against real bge-small-en-v1.5 vectors.
 *
 * The floor is the whole feature: it alone decides what every execution, retry and
 * review prompt is fed, and a wrong learning in context is worse than none. It is
 * therefore pinned from BOTH sides against real geometry, not merely documented —
 * 19 real tickets that must clear it, 3 deliberately off-topic tasks that must not.
 *
 * Vectors are committed rather than computed here so the suite stays hermetic (the
 * real model is a ~133MB download). Regenerate with
 * `npx tsx scripts/generate-injection-calibration.ts` and
 * `npx tsx scripts/generate-corpus-embeddings.ts`.
 *
 * The measurement mirrors production: each task is scored against the corpus scoped
 * to `[repo, "shared"]`, on the query text `injectionQueryText` builds, and the
 * statistic floored on is the best cosine similarity in scope. A task whose best
 * match sits below the floor injects nothing at all.
 */
const fixtures = path.join(testProjectRoot, "src", "execution", "__tests__", "fixtures");
const queriesPath = path.join(fixtures, "injection-calibration-queries.json");
const queryVectorsPath = path.join(fixtures, "injection-calibration-embeddings.json");
const corpusPath = path.join(testProjectRoot, "src", "eval", "retrieval", "fixtures", "corpus.json");
const corpusVectorsPath = path.join(testProjectRoot, "src", "orchestration", "__tests__", "fixtures", "corpus-embeddings.json");

type QueryVectors = { model: string; dims: number; inputDigest: string; queries: { id: string; kind: string; repo: string; vector: string }[] };
type CorpusVectors = { model: string; dims: number; inputDigest: string; learnings: { id: string; repo: string; vector: string }[] };
type CorpusLearning = { id: string; title: string; content: string };

// `Buffer.from(base64)` returns a view into a shared pool, so `.buffer` is the whole
// pool. Slicing by byteOffset/byteLength copies just this vector — the same trap
// `fromVectorBlob` guards in the sqlite repo.
const decodeVector = (base64: string): Float32Array => {
  const buffer = Buffer.from(base64, "base64");
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
};

const queries = JSON.parse(readFileSync(queriesPath, "utf8")) as CalibrationQuery[];
const queryVectors = JSON.parse(readFileSync(queryVectorsPath, "utf8")) as QueryVectors;
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusLearning[];
const corpusVectors = JSON.parse(readFileSync(corpusVectorsPath, "utf8")) as CorpusVectors;

const learnings = corpusVectors.learnings.map((learning) => ({
  learningId: learning.id,
  repo: learning.repo,
  vector: decodeVector(learning.vector),
}));
const queryVectorById = new Map(queryVectors.queries.map((query) => [query.id, decodeVector(query.vector)]));

const queryVectorFor = (query: CalibrationQuery): Float32Array => {
  const vector = queryVectorById.get(query.id);
  if (!vector) {
    throw new Error(`query fixture is missing a vector for ${query.id}`);
  }

  return vector;
};

/** The corpus the seam reads for this task: production scopes it to `[repo, "shared"]`. */
const embeddingsInScope = (query: CalibrationQuery): typeof learnings => {
  const scope = new Set([query.repo, "shared"]);
  const inScope = learnings.filter((learning) => scope.has(learning.repo));
  if (inScope.length === 0) {
    throw new Error(`corpus holds no learning in scope for ${query.id} (${query.repo} + shared)`);
  }

  return inScope;
};

/** The closest learning the task's scope holds — the statistic the floor is calibrated against. */
const bestSimilarityInScope = (query: CalibrationQuery): number =>
  Math.max(...embeddingsInScope(query).map((learning) => cosineSimilarity(queryVectorFor(query), learning.vector)));

/** Exactly what the seam injects: the real selector, at the real floor, under the real cap. */
const injectedFor = (query: CalibrationQuery) =>
  selectSimilarCandidates(queryVectorFor(query), embeddingsInScope(query), {
    minSimilarity: INJECTION_SIMILARITY_FLOOR,
    limit: RELEVANT_LEARNINGS_LIMIT,
  });

/** Every learning the floor would admit if nothing capped the list. */
const admissibleFor = (query: CalibrationQuery): number =>
  embeddingsInScope(query).filter((learning) => cosineSimilarity(queryVectorFor(query), learning.vector) >= INJECTION_SIMILARITY_FLOOR).length;

const byKind = (kind: CalibrationQuery["kind"]): CalibrationQuery[] => queries.filter((query) => query.kind === kind);
const realTasks = byKind("real");
const offTopicTasks = byKind("off-topic");

describe("injection similarity floor calibration", () => {
  test("the fixtures were built by the model production actually embeds with", () => {
    // Against the live factory, not a hardcoded string. A cosine scale is a
    // property of the model: swap the embedder and 0.70 silently becomes a
    // threshold on a distribution nobody measured, with the coverage gate offering
    // no signal once `backfill-embeddings` refills the corpus. This is the tripwire
    // for that. Reading `modelId`/`dims` does not init the model, so no download.
    const production = createEmbedder(testProjectRoot);
    expect(queryVectors.model).toBe(production.modelId);
    expect(queryVectors.dims).toBe(production.dims);
    expect(corpusVectors.model).toBe(production.modelId);
  });

  test("the fixtures hold one real-model vector per query and per corpus learning", () => {
    expect(queryVectors.queries.map((query) => query.id)).toEqual(queries.map((query) => query.id));
    expect(queryVectors.queries.every((query) => decodeVector(query.vector).length === queryVectors.dims)).toBe(true);
    expect(realTasks.length).toBe(19);
    expect(offTopicTasks.length).toBe(3);
  });

  test("both fixtures' vectors were computed from the inputs as they stand now", () => {
    // Everything below calibrates the floor against these vectors. Compared only
    // against themselves the fixtures cannot detect an edited task, an edited
    // corpus, or a change to how injection builds its query — and the suite would
    // stay green while measuring text nothing carries. Regenerate on failure, and
    // re-derive the floor, because the window it sits in will have moved.
    expect(queryVectors.inputDigest).toBe(injectionCalibrationDigest(queries));
    expect(corpusVectors.inputDigest).toBe(corpusEmbeddingDigest(corpus));
  });

  test.each(realTasks.map((query) => [query.id, query] as const))("a real task clears the floor: %s", (_id, query) => {
    expect(bestSimilarityInScope(query)).toBeGreaterThanOrEqual(INJECTION_SIMILARITY_FLOOR);
  });

  test.each(offTopicTasks.map((query) => [query.id, query] as const))("an off-topic task stays below the floor: %s", (_id, query) => {
    expect(bestSimilarityInScope(query)).toBeLessThan(INJECTION_SIMILARITY_FLOOR);
  });

  test("the floor sits inside the window separating real tasks from off-topic ones", () => {
    const weakestReal = Math.min(...realTasks.map(bestSimilarityInScope));
    const strongestOffTopic = Math.max(...offTopicTasks.map(bestSimilarityInScope));

    // Asserted to 4dp so a model or corpus change that moves the window fails here
    // — with the numbers needed to re-pick the floor — rather than silently
    // changing what every attempt prompt is fed.
    expect(weakestReal).toBeCloseTo(0.7163, 4);
    expect(strongestOffTopic).toBeCloseTo(0.6564, 4);

    // The two bounds that make the constant an empirical claim rather than a
    // preference. Together they reject both failure directions: too low and the
    // off-topic band is admitted (0.55 would push learnings at a shopping list),
    // too high and real work stops being served.
    expect(strongestOffTopic).toBeLessThan(INJECTION_SIMILARITY_FLOOR);
    expect(INJECTION_SIMILARITY_FLOOR).toBeLessThan(weakestReal);
  });

  test("the floor leans toward silence rather than sitting at the centre of the window", () => {
    const weakestReal = Math.min(...realTasks.map(bestSimilarityInScope));
    const strongestOffTopic = Math.max(...offTopicTasks.map(bestSimilarityInScope));
    const midpoint = (strongestOffTopic + weakestReal) / 2;

    // 0.70 is deliberately NOT the midpoint (0.6863): it keeps ~2.7x more margin
    // against admitting junk than against dropping a real ticket, because a wrong
    // learning in an agent's context costs more than a missing one. That is a
    // judgement, so it is pinned like one — moving the floor below the midpoint
    // reverses it, and has to fail a test rather than pass unnoticed.
    expect(midpoint).toBeCloseTo(0.6863, 4);
    expect(INJECTION_SIMILARITY_FLOOR).toBeGreaterThan(midpoint);
  });
});

/**
 * The floor decides what is close enough to push — but only over the candidates it is
 * shown. Sourced through the fused search, those candidates were first forced past
 * `COSINE_Z_FLOOR`, a bar that answers a different question ("did this stand out from
 * the corpus") for a different consumer (how far the dense arm may pad a search's
 * result window). On a homogeneous corpus the two questions do not merely differ, they
 * invert: z is LOWEST exactly for the on-topic queries injection exists to serve.
 *
 * These run the real selectors over the same committed vectors the floor is calibrated
 * on, so the reachability claim is falsifiable against real geometry rather than argued.
 */
describe("injection reachability", () => {
  test.each(realTasks.map((query) => [query.id, query] as const))("a real task reaches its cap's worth of learnings: %s", (_id, query) => {
    const injected = injectedFor(query);

    // A cap, not a quota: the scope yields as many as it holds, up to k.
    expect(injected).toHaveLength(Math.min(RELEVANT_LEARNINGS_LIMIT, admissibleFor(query)));
    expect(injected.every((candidate) => candidate.similarity >= INJECTION_SIMILARITY_FLOOR)).toBe(true);

    const similarities = injected.map((candidate) => candidate.similarity);
    expect(similarities).toEqual([...similarities].sort((left, right) => right - left));
  });

  test("the k = 5 window is reachable rather than aspirational", () => {
    const filled = realTasks.filter((query) => injectedFor(query).length === RELEVANT_LEARNINGS_LIMIT);

    // 18 of the 19 real tickets hold at least k admissible learnings and now get k.
    // The 19th is ENG-5687, whose `shipping-service` scope holds only 3 above the
    // floor — and it gets 3. Sourced through the z gate these same 19 tasks averaged
    // ~1.4 admitted candidates, and 4 of them got none at all.
    expect(filled).toHaveLength(18);
    expect(realTasks.filter((query) => admissibleFor(query) < RELEVANT_LEARNINGS_LIMIT).map((query) => query.id)).toEqual(["ENG-5687"]);
    expect(injectedFor(realTasks.find((query) => query.id === "ENG-5687")!)).toHaveLength(3);
  });

  test("the z gate hid what the floor admits: ENG-5685's own query goes 0 -> 5", () => {
    const query = realTasks.find((candidate) => candidate.id === "ENG-5685")!;
    const inScope = embeddingsInScope(query);

    // The ticket that built this fixture, served by the code that built it: the arm
    // the fused search ranks on proposes NOTHING from its own 83-learning scope, so no
    // floor — however well calibrated — had anything to admit.
    expect(selectCosineCandidates(queryVectorFor(query), inScope)).toEqual([]);

    // Meanwhile 50 of those 83 learnings sit above the floor, the closest at 0.7739.
    // They were never rejected as too distant; they never reached the bar to be judged.
    expect(admissibleFor(query)).toBe(50);
    expect(bestSimilarityInScope(query)).toBeCloseTo(0.7739, 4);

    const injected = injectedFor(query);
    expect(injected).toHaveLength(RELEVANT_LEARNINGS_LIMIT);
    expect(injected[0]!.similarity).toBeCloseTo(0.7739, 4);
  });

  test.each(offTopicTasks.map((query) => [query.id, query] as const))("an off-topic task still injects nothing: %s", (_id, query) => {
    const inScope = embeddingsInScope(query);

    // The z gate is not what was keeping these out, and dropping it costs the seam
    // nothing: it PROPOSES candidates for every off-topic task here — the lucky outlier
    // in a low, tight distribution — and the floor refuses every one. The bar that
    // protects an agent's context is, and always was, the absolute one.
    expect(selectCosineCandidates(queryVectorFor(query), inScope).length).toBeGreaterThan(0);
    expect(injectedFor(query)).toEqual([]);
  });
});
