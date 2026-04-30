import { promises as fs } from "node:fs";
import path from "node:path";

import fg from "fast-glob";
import matter from "gray-matter";
import { z } from "zod";

import { ForemanError } from "../lib/errors.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";

const intervalPattern = /^(\d+)([smhd])$/;

const cronFrontmatterSchema = z.object({
  interval: z.string().min(1),
  enabled: z.boolean().default(true),
});

export type CronJobDefinition = {
  id: string;
  title: string;
  absolutePath: string;
  relativePath: string;
  intervalMs: number;
  interval: string;
  enabled: boolean;
  body: string;
};

export const parseCronIntervalMs = (value: string): number => {
  const match = value.trim().match(intervalPattern);
  if (!match) {
    throw new ForemanError("invalid_cron_interval", `Cron interval must use an interval like 15m, 1h, or 1d: ${value}`, 400);
  }

  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * multipliers[unit]!;
};

const resolveCronJobsDir = (config: WorkspaceConfig, paths: WorkspacePaths): string =>
  path.resolve(paths.workspaceRoot, config.cron.jobsDir);

const assertWithinWorkspace = (paths: WorkspacePaths, candidate: string): void => {
  const workspaceRoot = path.resolve(paths.workspaceRoot);
  const resolved = path.resolve(candidate);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ForemanError("invalid_cron_jobs_dir", "cron.jobsDir must resolve inside the workspace root.", 400);
  }
};

export const discoverCronJobs = async (config: WorkspaceConfig, paths: WorkspacePaths): Promise<CronJobDefinition[]> => {
  const jobsDir = resolveCronJobsDir(config, paths);
  assertWithinWorkspace(paths, jobsDir);

  try {
    const stat = await fs.stat(jobsDir);
    if (!stat.isDirectory()) {
      throw new ForemanError("invalid_cron_jobs_dir", `Cron jobs path is not a directory: ${config.cron.jobsDir}`, 400);
    }
  } catch (error) {
    if (error instanceof ForemanError) {
      throw error;
    }
    return [];
  }

  const entries = await fg("**/*.md", { cwd: jobsDir, onlyFiles: true, dot: false, unique: true });
  const jobs = await Promise.all(
    entries.sort().map(async (entry) => {
      const absolutePath = path.join(jobsDir, entry);
      const parsed = matter(await fs.readFile(absolutePath, "utf8"));
      const frontmatter = cronFrontmatterSchema.parse(parsed.data);
      const relativePath = path.relative(paths.workspaceRoot, absolutePath);
      return {
        id: relativePath,
        title: path.basename(entry, ".md"),
        absolutePath,
        relativePath,
        intervalMs: parseCronIntervalMs(frontmatter.interval),
        interval: frontmatter.interval,
        enabled: frontmatter.enabled,
        body: parsed.content.trim(),
      };
    }),
  );

  return jobs;
};
