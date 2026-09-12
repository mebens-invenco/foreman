import { createHash } from "node:crypto";

import type { ActionType, AttemptStatus } from "../domain/index.js";
import { stableStringify } from "../lib/json.js";
import type { LoggerService } from "../logger.js";
import type { AttemptRepo } from "../repos/index.js";
import type { SlackDmReceipt } from "./slack-dm.js";

export type ProblemNotification = {
  attemptId: string;
  subjectKey: string;
  subject: string;
  action: ActionType;
  status: AttemptStatus;
  summary: string;
  url?: string | null;
};

const problemStatuses = new Set<AttemptStatus>(["blocked", "failed", "timed_out"]);
const suppressionWindowMs = 60 * 60 * 1_000;

export class SlackProblemNotifier {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: {
    attempts: AttemptRepo;
    isConfigured: () => boolean;
    send: (text: string) => Promise<SlackDmReceipt>;
    logger: LoggerService;
  }) {}

  notify(input: ProblemNotification): Promise<void> {
    if (!problemStatuses.has(input.status) || !this.deps.isConfigured()) {
      return Promise.resolve();
    }

    const fingerprint = this.fingerprint(input);
    const notification = (this.queues.get(fingerprint) ?? Promise.resolve()).then(() => this.sendIfNeeded(input, fingerprint));
    const queued = notification.catch(() => undefined);
    this.queues.set(fingerprint, queued);
    void queued.then(() => {
      if (this.queues.get(fingerprint) === queued) {
        this.queues.delete(fingerprint);
      }
    });
    return notification;
  }

  private fingerprint(input: ProblemNotification): string {
    return createHash("sha256")
      .update(stableStringify({ subjectKey: input.subjectKey, action: input.action, status: input.status, summary: input.summary }))
      .digest("hex");
  }

  private async sendIfNeeded(input: ProblemNotification, fingerprint: string): Promise<void> {
    if (!this.deps.isConfigured()) {
      return;
    }

    const since = new Date(Date.now() - suppressionWindowMs).toISOString();

    try {
      const recentlyAttempted =
        this.deps.attempts.hasAttemptEventWithFingerprintSince("slack_notification_sent", fingerprint, since) ||
        this.deps.attempts.hasAttemptEventWithFingerprintSince("slack_notification_failed", fingerprint, since);
      if (recentlyAttempted) {
        this.deps.attempts.addAttemptEvent(input.attemptId, "slack_notification_suppressed", "Suppressed a repeated Slack problem notification.", { fingerprint });
        return;
      }
    } catch (error) {
      this.recordFailure(input.attemptId, fingerprint, error);
      return;
    }

    const linkedSubject = input.url ? `<${input.url}|${input.subject}>` : input.subject;
    const prefix = `Foreman ${input.action} ${input.status} for ${linkedSubject}.\n`;
    const text = `${prefix}${input.summary}`.slice(0, 4_000);
    let receipt: SlackDmReceipt;
    try {
      receipt = await this.deps.send(text);
    } catch (error) {
      this.recordFailure(input.attemptId, fingerprint, error);
      return;
    }

    try {
      this.deps.attempts.addAttemptEvent(input.attemptId, "slack_notification_sent", "Sent a Slack problem notification.", {
        fingerprint,
        channelId: receipt.channelId,
        messageTs: receipt.messageTs,
      });
    } catch (error) {
      this.deps.logger.error("sent Slack problem notification but failed to store its receipt", {
        attemptId: input.attemptId,
        channelId: receipt.channelId,
        messageTs: receipt.messageTs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordFailure(attemptId: string, fingerprint: string, error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    try {
      this.deps.attempts.addAttemptEvent(attemptId, "slack_notification_failed", "Failed to send a Slack problem notification.", {
        fingerprint,
        error: message,
      });
    } catch (eventError) {
      this.deps.logger.error("failed to record Slack problem notification failure", {
        attemptId,
        error: eventError instanceof Error ? eventError.message : String(eventError),
      });
    }
    this.deps.logger.warn("Slack problem notification failed", { attemptId, error: message });
  }
}
