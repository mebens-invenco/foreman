import { z } from "zod";

import { ForemanError } from "../lib/errors.js";

const cronResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: z.string().trim().min(1),
    action: z
      .object({
        type: z.literal("send_slack_dm"),
        text: z.string().trim().min(1).max(4_000),
      })
      .strict(),
  })
  .strict();

export type CronResult = z.infer<typeof cronResultSchema>;

export const parseCronResult = (stdout: string): CronResult | null => {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("<cron-result>")) {
    return null;
  }

  const match = trimmed.match(/^<cron-result>\s*([\s\S]*?)\s*<\/cron-result>$/);
  if (!match) {
    throw new ForemanError("invalid_cron_result", "Cron output contains a malformed cron-result block.");
  }

  try {
    return cronResultSchema.parse(JSON.parse(match[1]!));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ForemanError("invalid_cron_result", `Cron result is invalid: ${message}`);
  }
};
