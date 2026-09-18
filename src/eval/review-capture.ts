import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const capturedReviewSchema = z.object({
  type: z.literal("submit_pull_request_review"),
  body: z.string().min(1),
  event: z.literal("COMMENT"),
  commit_id: z.string().regex(/^[a-f0-9]{40}$/),
  comments: z.array(z.object({
    path: z.string().min(1),
    line: z.number().int().positive(),
    side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
    body: z.string().min(1),
  })),
});

export const readReviewCapture = async (capturePath: string) =>
  z.array(capturedReviewSchema).parse(JSON.parse(await fs.readFile(capturePath, "utf8")));

export const captureReview = async (capturePath: string, headSha: string, payload: unknown): Promise<string> => {
  const review = capturedReviewSchema.parse({ ...(payload as object), type: "submit_pull_request_review" });
  if (review.commit_id !== headSha) {
    throw new Error("Review commit_id does not match the fixture head");
  }
  const reviews = await readReviewCapture(capturePath);
  reviews.push(review);
  await fs.writeFile(capturePath, JSON.stringify(reviews));
  return `EVAL_REVIEW_${reviews.length}`;
};

export const reviewCaptureDirective = (command: string): string => `
## Eval review submission transport

GitHub fixture PRs are frozen. Use GitHub only for reads; never publish, edit, upload, resolve, merge, close, or enable auto-merge on a fixture PR.
For this eval only, submit each review by running ${command} with a GitHub create-review JSON body on stdin (body, event, commit_id, comments). This local capture tool replaces the GitHub write API and returns a simulated node_id. Use that ID in the normal schema-version-2 reviewResult. Do not put review bodies in the final worker result. For no_action_needed, do not submit anything.
`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const nodeId = await captureReview(process.argv[2]!, process.argv[3]!, JSON.parse(Buffer.concat(chunks).toString("utf8")));
  process.stdout.write(`${JSON.stringify({ node_id: nodeId, state: "COMMENTED" })}\n`);
}
