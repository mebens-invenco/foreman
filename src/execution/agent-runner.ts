import type { AgentRunRequest, AgentRunResult } from "../domain.js";

export type AgentRunLineCallbacks = {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
};

export type AgentRunnerInvokeRequest = AgentRunRequest & {
  abortSignal?: AbortSignal;
} & AgentRunLineCallbacks;

export interface AgentRunner {
  invoke(request: AgentRunnerInvokeRequest): Promise<CapturedAgentRunResult>;
}

export type CapturedAgentRunResult = AgentRunResult & {
  stdout: string;
  stderr: string;
};
