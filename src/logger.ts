import { promises as fs } from "node:fs";
import path from "node:path";

import { ensureDir } from "./lib/fs.js";
import { isoNow } from "./lib/time.js";
import type { WorkspacePaths } from "./workspace/workspace-paths.js";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type LoggerLevelName = "debug" | "info" | "warn" | "error";
type LogValue = string | number | boolean | null | undefined;
type LogContext = Record<string, LogValue>;
type ColorMode = "auto" | "always" | "never";

type SharedLoggerState = {
  paths: WorkspacePaths | null;
  stdout: NodeJS.WritableStream;
  workspaceLogPath: string | null;
  queue: Promise<void>;
  colorEnabled: boolean;
  minLevel: LogLevel;
};

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  italic: "\u001B[3m",
  dimGray: "\u001B[90m",
  bgGray: "\u001B[100m",
  fgBlack: "\u001B[30m",
  fgWhite: "\u001B[37m",
  bgCyan: "\u001B[46m",
  bgGreen: "\u001B[42m",
  bgYellow: "\u001B[43m",
  bgRed: "\u001B[41m",
} as const;

const normalizeContext = (context: LogContext): Record<string, string | number | boolean | null> =>
  Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined)) as Record<string, string | number | boolean | null>;

const formatValue = (value: string | number | boolean | null): string => {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  return JSON.stringify(value.replace(/\r?\n/g, "\\n"));
};

const formatLine = (level: LogLevel, message: string, context: Record<string, string | number | boolean | null>): string => {
  const fields = Object.entries(context)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  const prefix = [isoNow(), level, ...fields].join(" ");
  return `${prefix} message=${formatValue(message)}\n`;
};

const style = (enabled: boolean, value: string, ...codes: string[]): string =>
  enabled ? `${codes.join("")}${value}${ANSI.reset}` : value;

const severityBadge = (enabled: boolean, level: LogLevel): string => {
  if (!enabled) {
    return level;
  }

  if (level === "DEBUG") {
    return style(enabled, ` ${level} `, ANSI.bgCyan, ANSI.fgBlack, ANSI.bold);
  }
  if (level === "INFO") {
    return style(enabled, ` ${level} `, ANSI.bgGreen, ANSI.fgBlack, ANSI.bold);
  }
  if (level === "WARN") {
    return style(enabled, ` ${level} `, ANSI.bgYellow, ANSI.fgBlack, ANSI.bold);
  }
  return style(enabled, ` ${level} `, ANSI.bgRed, ANSI.fgWhite, ANSI.bold);
};

const formatStdoutLine = (
  level: LogLevel,
  message: string,
  context: Record<string, string | number | boolean | null>,
  colorEnabled: boolean,
): string => {
  const { component: rawComponent, ...extraContext } = context;
  const component = typeof rawComponent === "string" && rawComponent ? rawComponent : "root";
  const extras = Object.entries(extraContext)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      const renderedValue = formatValue(value);
      return `${style(colorEnabled, `${key}=`, ANSI.dimGray, ANSI.italic)}${renderedValue}`;
    })
    .join(" ");

  const segments = [
    style(colorEnabled, isoNow(), ANSI.dimGray),
    severityBadge(colorEnabled, level),
    formatBadge(component, colorEnabled),
    message,
  ];

  if (extras) {
    segments.push(extras);
  }

  return `${segments.join(" ")}\n`;
};

const formatBadge = (label: string, colorEnabled: boolean): string => {
  const padded = ` ${label} `;
  return colorEnabled ? `${ANSI.bgGray}${ANSI.fgWhite}${ANSI.bold}${padded}${ANSI.reset}` : `[${label}]`;
};

const formatRunnerBadgeLabel = (context: Record<string, string | number | boolean | null>): string | null => {
  const workerSlot =
    typeof context.workerSlot === "number" && Number.isFinite(context.workerSlot)
      ? String(context.workerSlot)
      : typeof context.workerSlot === "string" && context.workerSlot
        ? context.workerSlot
        : null;
  const taskId = typeof context.taskId === "string" && context.taskId ? context.taskId : null;
  const workerId = typeof context.workerId === "string" && context.workerId ? context.workerId : null;

  if (workerSlot && taskId) {
    return `W${workerSlot} ${taskId}`;
  }

  if (workerSlot) {
    return `W${workerSlot}`;
  }

  return workerId;
};

const shouldUseColor = (stdout: NodeJS.WritableStream, colorMode: ColorMode): boolean => {
  if (colorMode === "always") {
    return true;
  }

  if (colorMode === "never") {
    return false;
  }

  if (process.env.NO_COLOR) {
    return false;
  }

  return Boolean("isTTY" in stdout && stdout.isTTY);
};

const normalizeLevel = (level: LoggerLevelName | LogLevel | undefined): LogLevel => {
  if (!level) {
    return "INFO";
  }

  const normalized = level.toUpperCase();
  if (normalized === "DEBUG" || normalized === "INFO" || normalized === "WARN" || normalized === "ERROR") {
    return normalized;
  }

  return "INFO";
};

export class LoggerService {
  constructor(
    private readonly state: SharedLoggerState,
    private readonly context: Record<string, string | number | boolean | null> = {},
  ) {}

  static create(input: {
    paths?: WorkspacePaths;
    stdout?: NodeJS.WritableStream;
    context?: LogContext;
    colorMode?: ColorMode;
    minLevel?: LoggerLevelName | LogLevel;
  } = {}): LoggerService {
    const paths = input.paths ?? null;
    const stdout = input.stdout ?? process.stdout;
    return new LoggerService(
      {
        paths,
        stdout,
        workspaceLogPath: paths ? path.join(paths.logsDir, "foreman.log") : null,
        queue: Promise.resolve(),
        colorEnabled: shouldUseColor(stdout, input.colorMode ?? "auto"),
        minLevel: normalizeLevel(input.minLevel),
      },
      { component: "root", ...normalizeContext(input.context ?? {}) },
    );
  }

  child(context: LogContext): LoggerService {
    return new LoggerService(this.state, { ...this.context, ...normalizeContext(context) });
  }

  debug(message: string, context: LogContext = {}): void {
    this.write("DEBUG", message, context);
  }

  info(message: string, context: LogContext = {}): void {
    this.write("INFO", message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.write("WARN", message, context);
  }

  error(message: string, context: LogContext = {}): void {
    this.write("ERROR", message, context);
  }

  line(source: string, message: string, context: LogContext = {}): void {
    this.write("INFO", message, { ...context, source });
  }

  runnerLine(message: string, context: LogContext = {}): void {
    const merged = { ...this.context, ...normalizeContext(context) };
    const attemptId = typeof merged.attemptId === "string" && merged.attemptId ? merged.attemptId : null;
    const fileLine = `${message}\n`;
    const badgeLabel = formatRunnerBadgeLabel(merged);
    const stdoutLine = badgeLabel ? `${formatBadge(badgeLabel, this.state.colorEnabled)} ${message}\n` : `${message}\n`;

    const appendAttempt = async (): Promise<void> => {
      if (!attemptId || !this.state.paths) {
        return;
      }

      const attemptLogPath = path.join(this.state.paths.attemptsLogDir, `${attemptId}.log`);
      await ensureDir(path.dirname(attemptLogPath));
      await fs.appendFile(attemptLogPath, fileLine, "utf8");
    };

    const next = this.state.queue.catch(() => undefined).then(async () => {
      try {
        this.state.stdout.write(stdoutLine);
      } catch {
        // ignore stdout write failures
      }

      await appendAttempt().catch(async (error) => {
        try {
          this.state.stdout.write(
            formatLine("ERROR", `failed to append attempt log: ${error instanceof Error ? error.message : String(error)}`, this.context),
          );
        } catch {
          // ignore secondary logging failure
        }
      });
    });

    this.state.queue = next;
  }

  flush(): Promise<void> {
    return this.state.queue;
  }

  private write(level: LogLevel, message: string, context: LogContext): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.state.minLevel]) {
      return;
    }

    const merged = { ...this.context, ...normalizeContext(context) };
    const fileLine = formatLine(level, message, merged);
    const stdoutLine = formatStdoutLine(level, message, merged, this.state.colorEnabled);
    const attemptId = typeof merged.attemptId === "string" && merged.attemptId ? merged.attemptId : null;

    const append = async (filePath: string): Promise<void> => {
      await ensureDir(path.dirname(filePath));
      await fs.appendFile(filePath, fileLine, "utf8");
    };

    const next = this.state.queue.catch(() => undefined).then(async () => {
      try {
        this.state.stdout.write(stdoutLine);
      } catch {
        // ignore stdout write failures
      }

      if (this.state.workspaceLogPath) {
        await append(this.state.workspaceLogPath).catch(async (error) => {
          try {
            this.state.stdout.write(
              formatLine("ERROR", `failed to append workspace log: ${error instanceof Error ? error.message : String(error)}`, this.context),
            );
          } catch {
            // ignore secondary logging failure
          }
        });
      }

      if (attemptId && this.state.paths) {
        const attemptLogPath = path.join(this.state.paths.attemptsLogDir, `${attemptId}.log`);
        await append(attemptLogPath).catch(async (error) => {
          try {
            this.state.stdout.write(
              formatLine("ERROR", `failed to append attempt log: ${error instanceof Error ? error.message : String(error)}`, this.context),
            );
          } catch {
            // ignore secondary logging failure
          }
        });
      }
    });

    this.state.queue = next;
  }
}
