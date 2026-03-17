import { exec } from "../lib/process.js";
import { LoggerService } from "../logger.js";
import type { ReviewService } from "./review-service.js";
import { GitHubReviewService } from "./impl/github-review-service.js";

export const resolveGitHubAuthEnv = async (env: Record<string, string>, logger?: LoggerService): Promise<Record<string, string>> => {
  const authLogger = (logger ?? LoggerService.create({ context: { component: "review.github.auth" }, colorMode: "never" })).child({
    component: "review.github.auth",
  });
  if (env.GH_TOKEN) {
    authLogger.debug("using GitHub token from environment");
    return env;
  }

  if (env.GH_CONFIG_DIR) {
    authLogger.debug("attempting to resolve GitHub token via gh auth token", { hasGhConfigDir: true });
    const token = (await exec("gh", ["auth", "token"], { env })).stdout.trim();
    if (token) {
      authLogger.info("resolved GitHub token via gh auth token");
      return { ...env, GH_TOKEN: token };
    }

    authLogger.warn("gh auth token did not return a GitHub token");
  }

  authLogger.warn("GitHub token was not resolved from the environment or gh auth token");
  return env;
};

export const createReviewService = (input: { env: Record<string, string>; logger?: LoggerService }): ReviewService =>
  new GitHubReviewService(input.env, input.logger?.child({ component: "review.github" }));
