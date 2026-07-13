/**
 * Regenerates the real-model query-vector fixture that INJECTION_SIMILARITY_FLOOR
 * is calibrated against.
 *
 *   npx tsx scripts/generate-injection-calibration.ts
 *
 * Committing the vectors keeps the calibration test hermetic: it pins the floor
 * against bge-small's actual geometry without downloading a ~133MB ONNX model on
 * every test run. The learning half of the comparison is the corpus fixture
 * already committed by `generate-corpus-embeddings.ts`.
 *
 * Re-run this only when the query fixture or the embedding model changes -- and
 * re-derive the floor alongside it, because the window it sits in will have moved.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createEmbedder } from "../src/embeddings/create-embedder.js";
import { injectionQueryText } from "../src/execution/inject-relevant-learnings.js";
import { injectionCalibrationDigest, type CalibrationQuery } from "../src/execution/__tests__/injection-calibration-digest.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(projectRoot, "src", "execution", "__tests__", "fixtures");
const queriesPath = path.join(fixturesDir, "injection-calibration-queries.json");
const outputPath = path.join(fixturesDir, "injection-calibration-embeddings.json");

const toBase64 = (vector: Float32Array): string =>
  Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");

const main = async (): Promise<void> => {
  const queries = JSON.parse(await readFile(queriesPath, "utf8")) as CalibrationQuery[];
  const embedder = createEmbedder(projectRoot);
  // `injectionQueryText`, not a local join: the fixture has to embed the exact
  // string production embeds, or it calibrates the floor for a query shape no
  // attempt ever issues.
  const vectors = await embedder.embed(queries.map(injectionQueryText));

  const fixture = {
    model: embedder.modelId,
    dims: embedder.dims,
    inputDigest: injectionCalibrationDigest(queries),
    queries: queries.map((query, index) => ({
      id: query.id,
      kind: query.kind,
      repo: query.repo,
      vector: toBase64(vectors[index]!),
    })),
  };

  await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(`wrote ${fixture.queries.length} query vectors (${fixture.model}, ${fixture.dims}d) to ${outputPath}`);
};

await main();
