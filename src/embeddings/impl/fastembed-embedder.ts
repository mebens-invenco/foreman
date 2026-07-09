import { EmbeddingModel, FlagEmbedding } from "fastembed";

import { ForemanError } from "../../lib/errors.js";
import { ensureDir } from "../../lib/fs.js";
import type { Embedder } from "../embedder.js";

const MODEL_ID = "bge-small-en-v1.5";
const MODEL_DIMS = 384;

/**
 * In-process embedder backed by fastembed's ONNX runtime. No network is used
 * after the first init, which downloads the ~133MB model into `cacheDir`
 * (fastembed ships this model as an unquantized fp32 ONNX).
 */
export class FastembedEmbedder implements Embedder {
  readonly modelId = MODEL_ID;
  readonly dims = MODEL_DIMS;
  private model: Promise<FlagEmbedding> | null = null;

  constructor(private readonly cacheDir: string) {}

  private init(): Promise<FlagEmbedding> {
    // Cache the promise rather than the resolved model so concurrent first
    // callers share one download instead of racing two. A rejection clears the
    // cache: a transient download failure must not poison the process.
    this.model ??= this.loadModel().catch((error: unknown) => {
      this.model = null;
      throw error;
    });

    return this.model;
  }

  private async loadModel(): Promise<FlagEmbedding> {
    // fastembed creates `cacheDir` with a non-recursive mkdirSync, so it throws
    // ENOENT unless every parent already exists.
    await ensureDir(this.cacheDir);
    return FlagEmbedding.init({
      model: EmbeddingModel.BGESmallENV15,
      cacheDir: this.cacheDir,
      showDownloadProgress: false,
    });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    const model = await this.init();
    const vectors: Float32Array[] = [];
    for await (const batch of model.embed(texts)) {
      for (const vector of batch) {
        vectors.push(Float32Array.from(vector));
      }
    }

    // Callers zip these against their inputs by index, so a short result would
    // silently attach the wrong vector to the wrong record.
    if (vectors.length !== texts.length) {
      throw new ForemanError(
        "embedding_count_mismatch",
        `Embedder returned ${vectors.length} vectors for ${texts.length} texts`,
        500,
      );
    }

    // Callers persist `dims` from this port alongside a BLOB built from the
    // vector itself. If the model's true width ever drifts from MODEL_DIMS,
    // every row would claim a width it does not have and readers striding by
    // `dims` would silently decode garbage.
    const widthMismatch = vectors.find((vector) => vector.length !== this.dims);
    if (widthMismatch) {
      throw new ForemanError(
        "embedding_dims_mismatch",
        `Embedder ${this.modelId} produced a ${widthMismatch.length}-dim vector but declares ${this.dims} dims`,
        500,
      );
    }

    return vectors;
  }
}
