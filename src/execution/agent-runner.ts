import type { ActionType, AgentRunRequest, AgentRunResult } from "../domain/index.js";
import type { NormalizedRunnerActivity } from "../repos/attempt-activity-repo.js";

export type AgentRunLineCallbacks = {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /**
   * Called once per normalized activity decoded from a runner stdout/stderr
   * line. Runners pass a normalizer to {@link runAgentProcess} that converts
   * a raw line into zero or more {@link NormalizedRunnerActivity}s; this
   * callback is the live drain for those.
   */
  onActivity?: (activity: NormalizedRunnerActivity) => void;
};

export type AgentRunnerInvokeRequest = AgentRunRequest & {
  action: ActionType;
  abortSignal?: AbortSignal;
} & AgentRunLineCallbacks;

export interface AgentRunner {
  invoke(request: AgentRunnerInvokeRequest): Promise<CapturedAgentRunResult>;
}

export type CapturedAgentRunResult = AgentRunResult & {
  stdout: string;
  stderr: string;
};
