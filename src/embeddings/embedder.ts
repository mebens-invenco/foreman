/**
 * Text embedding port. Implementations are expected to be expensive to
 * initialize and cheap to call thereafter, so callers should hold one instance
 * for the lifetime of the process.
 */
export interface Embedder {
  /** Stable identifier persisted alongside every vector, e.g. "bge-small-en-v1.5". */
  readonly modelId: string;
  /** Vector length every `embed` result is guaranteed to have. */
  readonly dims: number;
  /** Returns one vector per input text, in input order. */
  embed(texts: string[]): Promise<Float32Array[]>;
}
