import type { WorkspaceConfig, WorkspacePaths } from "../config.js";
import { LoggerService } from "../logger.js";
import type { TaskSystem } from "./task-system.js";
import { FileTaskSystem } from "./impl/file-task-system.js";
import { LinearTaskSystem } from "./impl/linear-task-system.js";

export const createTaskSystem = (input: {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  env: Record<string, string>;
  logger?: LoggerService;
}): TaskSystem => {
  if (input.config.taskSystem.type === "file") {
    return new FileTaskSystem(input.config, input.paths);
  }

  return new LinearTaskSystem(input.config, input.env, input.logger?.child({ component: "taskSystem.linear" }));
};
