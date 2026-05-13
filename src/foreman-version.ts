import { exec, type ExecResult } from "./lib/process.js";
import type { WorkspacePaths } from "./workspace/workspace-paths.js";

export type ForemanVersionStatus = {
  commit: string | null;
  shortCommit: string | null;
  upstreamRef: string | null;
  upstreamCommit: string | null;
  behindBy: number | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  errorMessage: string | null;
};

type ExecGit = (args: string[]) => Promise<ExecResult>;

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 10_000;

export const unavailableForemanVersionStatus = (): ForemanVersionStatus => ({
  commit: null,
  shortCommit: null,
  upstreamRef: null,
  upstreamCommit: null,
  behindBy: null,
  updateAvailable: false,
  checkedAt: null,
  errorMessage: null,
});

const firstLine = (output: string): string => output.trim().split(/\r?\n/, 1)[0] ?? "";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class ForemanVersionMonitor {
  private status = unavailableForemanVersionStatus();
  private timer: NodeJS.Timeout | null = null;
  private readonly execGit: ExecGit;

  constructor(
    private readonly paths: WorkspacePaths,
    options: { execGit?: ExecGit; checkIntervalMs?: number } = {},
  ) {
    this.execGit = options.execGit ?? ((args) => exec("git", args, { cwd: this.paths.projectRoot, timeoutMs: GIT_TIMEOUT_MS }));
    this.checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
  }

  private readonly checkIntervalMs: number;

  start(): void {
    if (this.timer) {
      return;
    }

    void this.checkNow();
    this.timer = setInterval(() => {
      void this.checkNow();
    }, this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): ForemanVersionStatus {
    return { ...this.status };
  }

  async checkNow(): Promise<void> {
    const checkedAt = new Date().toISOString();
    const nextStatus: ForemanVersionStatus = {
      ...unavailableForemanVersionStatus(),
      checkedAt,
    };

    try {
      nextStatus.commit = firstLine((await this.execGit(["rev-parse", "HEAD"])).stdout) || null;
      nextStatus.shortCommit = firstLine((await this.execGit(["rev-parse", "--short", "HEAD"])).stdout) || null;
    } catch (error) {
      this.status = {
        ...nextStatus,
        errorMessage: errorMessage(error),
      };
      return;
    }

    try {
      await this.execGit(["fetch", "--quiet", "origin"]);
      const upstreamRef = await this.resolveUpstreamRef();
      nextStatus.upstreamRef = upstreamRef;
      nextStatus.upstreamCommit = firstLine((await this.execGit(["rev-parse", upstreamRef])).stdout) || null;
      const behindBy = Number.parseInt(firstLine((await this.execGit(["rev-list", "--count", `HEAD..${upstreamRef}`])).stdout), 10);
      nextStatus.behindBy = Number.isFinite(behindBy) ? behindBy : null;
      nextStatus.updateAvailable = (nextStatus.behindBy ?? 0) > 0;
      nextStatus.errorMessage = null;
    } catch (error) {
      nextStatus.errorMessage = errorMessage(error);
    }

    this.status = nextStatus;
  }

  private async resolveUpstreamRef(): Promise<string> {
    try {
      return firstLine((await this.execGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).stdout);
    } catch {
      return firstLine((await this.execGit(["rev-parse", "--abbrev-ref", "origin/HEAD"])).stdout);
    }
  }
}
