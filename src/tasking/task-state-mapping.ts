import type { WorkspaceConfig } from "../config.js";
import type { TaskState } from "../domain/index.js";
import { ForemanError } from "../lib/errors.js";

const normalizedStateMap = (config: WorkspaceConfig): Record<string, TaskState> => {
  if (config.taskSystem.type === "linear") {
    const states = config.taskSystem.linear!.states;
    return Object.fromEntries([
      ...states.ready.map((value) => [value, "ready"]),
      ...states.inProgress.map((value) => [value, "in_progress"]),
      ...states.inReview.map((value) => [value, "in_review"]),
      ...states.done.map((value) => [value, "done"]),
      ...states.canceled.map((value) => [value, "canceled"]),
    ]);
  }

  const states = config.taskSystem.file!.states;
  return Object.fromEntries([
    ...states.ready.map((value) => [value, "ready"]),
    ...states.inProgress.map((value) => [value, "in_progress"]),
    ...states.inReview.map((value) => [value, "in_review"]),
    ...states.done.map((value) => [value, "done"]),
    ...states.canceled.map((value) => [value, "canceled"]),
  ]);
};

export const normalizeTaskState = (config: WorkspaceConfig, providerState: string): TaskState => {
  const mapped = normalizedStateMap(config)[providerState];
  if (!mapped) {
    throw new ForemanError("unknown_provider_state", `Unmapped provider state: ${providerState}`);
  }
  return mapped;
};

export const getProviderStateForNormalized = (config: WorkspaceConfig, state: TaskState): string => {
  const stateConfig = config.taskSystem.type === "linear" ? config.taskSystem.linear!.states : config.taskSystem.file!.states;
  switch (state) {
    case "ready":
      return stateConfig.ready[0]!;
    case "in_progress":
      return stateConfig.inProgress[0]!;
    case "in_review":
      return stateConfig.inReview[0]!;
    case "done":
      return stateConfig.done[0]!;
    case "canceled":
      return stateConfig.canceled[0]!;
  }
};
