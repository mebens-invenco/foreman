import { createHash } from "node:crypto";

import { injectionQueryText } from "../inject-relevant-learnings.js";

export type CalibrationQuery = {
  id: string;
  /** `real` tasks must clear the floor; `off-topic` ones must not. */
  kind: "real" | "off-topic";
  /** The repo the task targets; the corpus is scoped to `[repo, "shared"]`, as production scopes it. */
  repo: string;
  title: string;
  description: string;
};

/**
 * Digest of the exact query texts the calibration vectors were generated from.
 * `scripts/generate-injection-calibration.ts` stamps it into the vector fixture;
 * the calibration test recomputes it from the query fixture and refuses to run
 * against a mismatch.
 *
 * It hashes what the embedder actually sees — the id the test indexes by, plus
 * `injectionQueryText` — so editing a task's text, reordering the fixture, or
 * changing how injection builds its query all invalidate the vectors rather than
 * silently pinning the floor against text no task carries.
 */
export const injectionCalibrationDigest = (queries: readonly CalibrationQuery[]): string => {
  const hash = createHash("sha256");
  for (const query of queries) {
    // U+0000 as a field separator, written as an escape: a raw NUL byte would make
    // git classify this source file as binary and hide it from review.
    hash.update(query.id);
    hash.update("\u0000");
    hash.update(injectionQueryText(query));
    hash.update("\u0000");
  }

  return hash.digest("hex");
};
