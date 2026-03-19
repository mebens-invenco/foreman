import { LoggerService } from "../logger.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";
import type { TaskSystem } from "./task-system.js";
import { FileTaskSystem } from "./impl/file-task-system.js";
import { LinearTaskSystem } from "./impl/linear-task-system.js";

export const createTaskSystem = (input: {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  env: Record<string, string>;
  logger?: LoggerService;
}): TaskSystem => {
  let taskSystem: TaskSystem;
  switch (input.config.taskSystem.type) {
    case "file": {
      if (!input.config.taskSystem.file) {
        throw new Error("File task system config is required when type=file");
      }

      taskSystem = new FileTaskSystem(input.config, input.paths, input.logger?.child({ component: "taskSystem.file" }));
      break;
    }

    case "linear": {
      if (!input.config.taskSystem.linear) {
        throw new Error("Linear task system config is required when type=linear");
      }

      taskSystem = new LinearTaskSystem(input.config, input.env, input.logger?.child({ component: "taskSystem.linear" }));
      break;
    }

    default:
      throw new Error(`Unsupported task system type: ${String((input.config.taskSystem as { type?: unknown }).type)}`);
  }

  return taskSystem;
};
