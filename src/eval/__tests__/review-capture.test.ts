import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createTempDir } from "../../test-support/helpers.js";
import { captureReview, readReviewCapture, reviewCaptureDirective } from "../review-capture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

test("captures review contents separately from worker receipts and rejects the wrong head", async () => {
  const directory = await createTempDir("foreman-review-capture-");
  directories.push(directory);
  const capturePath = path.join(directory, "reviews.json");
  await fs.writeFile(capturePath, "[]");
  const head = "a".repeat(40);
  const review = { body: "One finding", event: "COMMENT", commit_id: head, comments: [{ path: "src/a.ts", line: 4, body: "Missing validation" }] };
  await expect(captureReview(capturePath, head, review)).resolves.toBe("EVAL_REVIEW_1");
  expect(await readReviewCapture(capturePath)).toMatchObject([{ ...review, type: "submit_pull_request_review" }]);
  await expect(captureReview(capturePath, "b".repeat(40), review)).rejects.toThrow("fixture head");
  expect(await readReviewCapture(capturePath)).toHaveLength(1);
  expect(reviewCaptureDirective("node capture.js")).toContain("GitHub only for reads");
});
