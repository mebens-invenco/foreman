/**
 * Regenerates the real-model embedding fixture the near-duplicate threshold is
 * calibrated against.
 *
 *   npx tsx scripts/generate-corpus-embeddings.ts
 *
 * Committing the vectors keeps the calibration test hermetic: it pins the
 * threshold against bge-small's actual geometry without downloading a ~133MB
 * ONNX model on every test run. Re-run this only when the corpus fixture or the
 * embedding model changes -- a new threshold must be re-derived alongside it.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createEmbedder } from "../src/embeddings/create-embedder.js";
import { learningEmbeddingText } from "../src/embeddings/learning-embedding-text.js";
import { corpusEmbeddingDigest } from "../src/orchestration/__tests__/corpus-embedding-digest.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = path.join(projectRoot, "src", "eval", "retrieval", "fixtures", "corpus.json");
const outputPath = path.join(projectRoot, "src", "orchestration", "__tests__", "fixtures", "corpus-embeddings.json");

type CorpusLearning = { id: string; title: string; repo: string; content: string };

const toBase64 = (vector: Float32Array): string =>
  Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");

const main = async (): Promise<void> => {
  const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as CorpusLearning[];
  const embedder = createEmbedder(projectRoot);
  const vectors = await embedder.embed(corpus.map(learningEmbeddingText));

  const fixture = {
    model: embedder.modelId,
    dims: embedder.dims,
    // Ties the vectors to the exact canonical inputs they were computed from.
    // Without it the calibration test validates the fixture only against itself,
    // and a corpus or `learningEmbeddingText` change silently leaves it green
    // against vectors that no longer describe the corpus.
    inputDigest: corpusEmbeddingDigest(corpus),
    learnings: corpus.map((learning, index) => ({
      id: learning.id,
      repo: learning.repo,
      title: learning.title,
      vector: toBase64(vectors[index]!),
    })),
  };

  await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(`wrote ${fixture.learnings.length} vectors (${fixture.model}, ${fixture.dims}d) to ${outputPath}`);
};

await main();
