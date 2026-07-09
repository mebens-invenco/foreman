import path from "node:path";

import type { Embedder } from "./embedder.js";
import { FastembedEmbedder } from "./impl/fastembed-embedder.js";

/**
 * Model cache lives at the project root rather than per-workspace so several
 * workspaces on one checkout share a single ~30MB download.
 */
export const embedderCacheDir = (projectRoot: string): string => path.join(projectRoot, ".cache", "fastembed");

export const createEmbedder = (projectRoot: string): Embedder => new FastembedEmbedder(embedderCacheDir(projectRoot));
