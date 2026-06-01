import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RunnerProvider } from "../domain/index.js";
import { createAgentRunner } from "../execution/create-agent-runner.js";
import { renderWorkerPrompt } from "../execution/render-worker-prompt.js";
import { parseWorkerResult, validateWorkerResultForAction } from "../execution/worker-result.js";
import { createDefaultWorkspaceConfig, runnerProviderSchema, type WorkspaceConfig } from "../workspace/config.js";
import { findProjectRoot, type WorkspacePaths } from "../workspace/workspace-paths.js";
import { EVAL_REGISTRY } from "./registry.js";
import type { CaseResult, EvalCase, EvalReport, GradeContext, Grader, SampleResult } from "./types.js";

export type RunEvalOptions = {
  prompt: string;
  samplesPerCase: number;
  timeoutMs: number;
  judge: boolean;
  runner?: RunnerProvider;
  model?: string;
  caseId?: string;
  showOutput?: boolean;
};

// The agent runs against a throwaway repo dir inside the eval workspace; the
// rendered prompt references it but a synthetic-session eval never touches it.
const EVAL_REPO_KEY = "eval-repo";

const buildEvalConfig = (provider: "file" | "linear", runner?: RunnerProvider, model?: string): WorkspaceConfig => {
  const config = createDefaultWorkspaceConfig("eval", provider);
  if (runner) {
    const runnerConfig = runnerProviderSchema.parse({ type: runner, ...(model ? { model } : {}) });
    config.runner = { execution: runnerConfig, reviewer: runnerConfig };
  } else if (model) {
    config.runner = {
      execution: runnerProviderSchema.parse({ ...config.runner.execution, model }),
      reviewer: runnerProviderSchema.parse({ ...config.runner.reviewer, model }),
    };
  }
  return config;
};

const buildEvalPaths = async (): Promise<{ paths: WorkspacePaths; cleanup: () => Promise<void> }> => {
  const projectRoot = await findProjectRoot();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-eval-"));
  const paths: WorkspacePaths = {
    projectRoot,
    workspaceRoot,
    configPath: path.join(workspaceRoot, "foreman.workspace.yml"),
    envPath: path.join(workspaceRoot, ".env"),
    dbPath: path.join(workspaceRoot, "foreman.db"),
    logsDir: path.join(workspaceRoot, "logs"),
    attemptsLogDir: path.join(workspaceRoot, "logs", "attempts"),
    artifactsDir: path.join(workspaceRoot, "artifacts"),
    worktreesDir: path.join(workspaceRoot, "worktrees"),
    tasksDir: path.join(workspaceRoot, "tasks"),
    planPath: path.join(workspaceRoot, "plan.md"),
  };
  return { paths, cleanup: () => fs.rm(workspaceRoot, { recursive: true, force: true }) };
};

const syntheticSessionBlock = (evalCase: EvalCase): string =>
  [
    "## Eval Harness Directive (simulated session)",
    "",
    "You are being run inside an automated evaluation of the end-of-run steps, not a live task. The implementation work for the task above is COMPLETE. Treat the following as a faithful account of what happened in that session:",
    "",
    evalCase.syntheticSession.trim(),
    "",
    "Do not perform any further implementation, code changes, or git / task-provider / review-system actions — that work is already done. Now complete your END-OF-RUN steps exactly as instructed above: the learning review and the output validation. Run the `agent-result validate` command to check your final block as instructed, then emit exactly one final <agent-result> block with no prose after the closing tag.",
  ].join("\n");

const assembleCasePrompt = async (evalCase: EvalCase, paths: WorkspacePaths, config: WorkspaceConfig): Promise<string> => {
  const repoRoot = path.join(paths.workspaceRoot, EVAL_REPO_KEY);
  await fs.mkdir(repoRoot, { recursive: true });
  const rendered = await renderWorkerPrompt({
    action: evalCase.action,
    config,
    paths,
    task: evalCase.task,
    repo: { key: EVAL_REPO_KEY, rootPath: repoRoot, defaultBranch: "main" },
    worktreePath: repoRoot,
    baseBranch: "main",
  });
  return `${rendered}\n\n${syntheticSessionBlock(evalCase)}\n`;
};

const buildJudgeInvoker =
  (config: WorkspaceConfig, cwd: string, timeoutMs: number) =>
  async (prompt: string): Promise<string> => {
    const runner = createAgentRunner({ config, action: "execution" });
    const captured = await runner.invoke({ attemptId: randomUUID(), cwd, env: {}, prompt, timeoutMs, action: "execution" });
    return captured.stdout;
  };

type CaseRunDeps = {
  samplesPerCase: number;
  timeoutMs: number;
  invokeModel?: (prompt: string) => Promise<string>;
  showOutput?: boolean;
};

const runCase = async (evalCase: EvalCase, graders: Grader[], config: WorkspaceConfig, paths: WorkspacePaths, deps: CaseRunDeps): Promise<CaseResult> => {
  // The rendered prompt is identical across samples; only the model output varies.
  const prompt = await assembleCasePrompt(evalCase, paths, config);
  const repoRoot = path.join(paths.workspaceRoot, EVAL_REPO_KEY);
  const samples: SampleResult[] = [];

  for (let sampleIndex = 0; sampleIndex < deps.samplesPerCase; sampleIndex += 1) {
    const runner = createAgentRunner({ config, action: evalCase.action });
    const captured = await runner.invoke({ attemptId: randomUUID(), cwd: repoRoot, env: {}, prompt, timeoutMs: deps.timeoutMs, action: evalCase.action });

    if (deps.showOutput) {
      process.stderr.write(`\n--- ${evalCase.id} sample ${sampleIndex} raw stdout ---\n${captured.stdout}\n--- end raw stdout ---\n`);
    }

    let result = null;
    let parseError: string | undefined;
    try {
      result = validateWorkerResultForAction(parseWorkerResult(captured.stdout), evalCase.action);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }

    const ctx: GradeContext = {
      evalCase,
      result,
      rawStdout: captured.stdout,
      ...(parseError ? { parseError } : {}),
      ...(deps.invokeModel ? { invokeModel: deps.invokeModel } : {}),
    };
    const graderResults = await Promise.all(graders.map((grader) => grader.grade(ctx)));
    samples.push({ sampleIndex, parsed: result !== null, graderResults, pass: graderResults.every((entry) => entry.pass) });
  }

  const passRate = samples.length > 0 ? samples.filter((sample) => sample.pass).length / samples.length : 0;
  return { caseId: evalCase.id, description: evalCase.description, samples, passRate };
};

export const runEval = async (options: RunEvalOptions): Promise<EvalReport> => {
  const definition = EVAL_REGISTRY[options.prompt];
  if (!definition) {
    throw new Error(`Unknown eval prompt "${options.prompt}". Known: ${Object.keys(EVAL_REGISTRY).join(", ")}`);
  }

  const cases = options.caseId ? definition.cases.filter((evalCase) => evalCase.id === options.caseId) : definition.cases;
  if (cases.length === 0) {
    throw new Error(`No case "${options.caseId ?? ""}" found in eval "${options.prompt}"`);
  }

  const { paths, cleanup } = await buildEvalPaths();
  try {
    const caseResults: CaseResult[] = [];
    let runnerLabel = "default";
    let modelLabel = "default";

    for (const evalCase of cases) {
      const config = buildEvalConfig(evalCase.provider, options.runner, options.model);
      const activeRunner = config.runner[evalCase.action === "reviewer" ? "reviewer" : "execution"];
      runnerLabel = activeRunner.type;
      modelLabel = activeRunner.model;

      const invokeModel = options.judge ? buildJudgeInvoker(config, paths.workspaceRoot, options.timeoutMs) : undefined;
      const caseResult = await runCase(evalCase, definition.graders, config, paths, {
        samplesPerCase: options.samplesPerCase,
        timeoutMs: options.timeoutMs,
        ...(invokeModel ? { invokeModel } : {}),
        ...(options.showOutput ? { showOutput: true } : {}),
      });
      caseResults.push(caseResult);
    }

    const overallPassRate = caseResults.length > 0 ? caseResults.reduce((sum, entry) => sum + entry.passRate, 0) / caseResults.length : 0;
    return { prompt: options.prompt, runner: runnerLabel, model: modelLabel, samplesPerCase: options.samplesPerCase, cases: caseResults, overallPassRate };
  } finally {
    await cleanup();
  }
};

const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`;

export const formatEvalReport = (report: EvalReport): string => {
  const lines: string[] = [];
  lines.push(`Eval: ${report.prompt}   runner=${report.runner} model=${report.model}   samples/case=${report.samplesPerCase}`);
  lines.push(`Overall pass-rate: ${pct(report.overallPassRate)}`);
  lines.push("");

  for (const caseResult of report.cases) {
    lines.push(`• ${caseResult.caseId} — ${pct(caseResult.passRate)}  (${caseResult.description})`);
    // Show the dimension breakdown from the first failing sample, else the first sample.
    const sample = caseResult.samples.find((entry) => !entry.pass) ?? caseResult.samples[0];
    if (sample) {
      for (const grader of sample.graderResults) {
        const score = grader.score !== undefined ? ` [${grader.score}/5]` : "";
        lines.push(`    ${grader.pass ? "✓" : "✗"} ${grader.dimension}${score}: ${grader.detail}`);
      }
    }
  }

  return lines.join("\n");
};
