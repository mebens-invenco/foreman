import type { Embedder } from "../embeddings/embedder.js";

/**
 * Deterministic in-memory embedder. Tests must never download the real model,
 * so every code path that needs an `Embedder` gets this instead.
 */
export class FakeEmbedder implements Embedder {
  readonly modelId: string;
  readonly dims = 3;
  /** One entry per `embed` call, holding the texts that call received. */
  readonly calls: string[][] = [];
  failure: Error | null = null;

  constructor(modelId = "fake-embedder-v1") {
    this.modelId = modelId;
  }

  get embeddedTexts(): string[] {
    return this.calls.flat();
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    if (this.failure) {
      throw this.failure;
    }

    // Distinct per text and stable across runs, so assertions can tie a vector
    // back to the exact text that produced it.
    return texts.map((text, index) => Float32Array.from([text.length, index, checksum(text)]));
  }
}

const checksum = (text: string): number => {
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    total = (total + text.charCodeAt(index) * (index + 1)) % 1_000;
  }

  return total;
};
