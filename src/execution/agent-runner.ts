import type { ActionType, AgentRunRequest, AgentRunResult } from "../domain/index.js";

export type AgentRunLineCallbacks = {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
};

export type AgentRunnerInvokeRequest = AgentRunRequest & {
  action: ActionType;
  abortSignal?: AbortSignal;
} & AgentRunLineCallbacks;

export interface AgentRunner {
  invoke(request: AgentRunnerInvokeRequest): Promise<CapturedAgentRunResult>;
}

export type RetryableRunnerInterruption = {
  summary: string;
};

export type CapturedAgentRunResult = AgentRunResult & {
  stdout: string;
  stderr: string;
  retryableInterruption?: RetryableRunnerInterruption;
};
