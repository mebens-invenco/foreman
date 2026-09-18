import { z } from "zod";

import { ForemanError } from "../lib/errors.js";
import { createTimeoutSignal } from "../lib/fetch-timeout.js";

const slackApiResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

const conversationsOpenResponseSchema = z.object({
  channel: z.object({ id: z.string().min(1) }),
});

const chatPostMessageResponseSchema = z.object({
  channel: z.string().min(1),
  ts: z.string().min(1),
});

export type SlackDmReceipt = {
  channelId: string;
  messageTs: string;
};

const callSlack = async (token: string, method: string, body: Record<string, unknown>, timeoutMs: number) => {
  let response: Response;
  try {
    response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: createTimeoutSignal(timeoutMs),
    });
  } catch (error) {
    throw new ForemanError("slack_request_failed", `Slack ${method} request failed: ${error instanceof Error ? error.message : String(error)}`, 502);
  }

  if (!response.ok) {
    throw new ForemanError("slack_request_failed", `Slack ${method} request failed with HTTP ${response.status}.`, 502);
  }

  const responseBody = await response.json();
  const parsed = slackApiResponseSchema.safeParse(responseBody);
  if (!parsed.success || !parsed.data.ok) {
    throw new ForemanError("slack_api_error", `Slack ${method} failed: ${parsed.success ? parsed.data.error ?? "unknown_error" : "invalid_response"}`, 502);
  }

  return responseBody;
};

export const postSlackDm = async (input: {
  token: string;
  targetUserId: string;
  text: string;
  timeoutMs?: number;
}): Promise<SlackDmReceipt> => {
  if (input.text.length === 0 || input.text.length > 4_000) {
    throw new ForemanError("invalid_slack_message", "Slack messages must contain 1 to 4,000 characters.");
  }

  const timeoutMs = input.timeoutMs ?? 10_000;
  const opened = conversationsOpenResponseSchema.safeParse(
    await callSlack(input.token, "conversations.open", { users: input.targetUserId }, timeoutMs),
  );
  if (!opened.success) {
    throw new ForemanError("slack_api_error", "Slack conversations.open returned no channel ID.", 502);
  }

  const posted = chatPostMessageResponseSchema.safeParse(
    await callSlack(
      input.token,
      "chat.postMessage",
      {
        channel: opened.data.channel.id,
        text: input.text,
        unfurl_links: false,
        unfurl_media: false,
      },
      timeoutMs,
    ),
  );
  if (!posted.success) {
    throw new ForemanError("slack_api_error", "Slack chat.postMessage returned no channel ID or message timestamp.", 502);
  }

  return { channelId: posted.data.channel, messageTs: posted.data.ts };
};
