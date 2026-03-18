import { promises as fs } from "node:fs";
import path from "node:path";

import type { WorkspacePaths } from "../workspace/workspace-paths.js";

export type PromptTemplateName = "plan" | "execution" | "review" | "retry" | "consolidation";
export type WorkerPromptTemplateName = Exclude<PromptTemplateName, "plan">;

const TEMPLATE_PATHS: Record<PromptTemplateName, string> = {
  plan: "prompts/templates/plan.md",
  execution: "prompts/templates/execution.md",
  review: "prompts/templates/review.md",
  retry: "prompts/templates/retry.md",
  consolidation: "prompts/templates/consolidation.md",
};

const FRAGMENTS_DIR = path.join("prompts", "fragments");
const fragmentTokenPattern = /\{\{fragment:([a-zA-Z0-9_-]+)\}\}/g;
const contextTokenPattern = /\{\{context:([a-zA-Z0-9_-]+)\}\}/g;
const propertyTokenPattern = /\{\{([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*)\}\}/g;

export const markdownSection = (title: string, body: string): string => `## ${title}\n\n${body}`;

export const jsonSection = (title: string, value: unknown): string =>
  markdownSection(title, ["```json", JSON.stringify(value, null, 2), "```"].join("\n"));

export const textSection = (title: string, body: string): string => markdownSection(title, body.trim() || "(none)");

const resolveTemplateProperty = (source: unknown, rawPath: string): string => {
  const resolved = rawPath
    .split(":")
    .reduce<unknown>((current, segment) => (current && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined), source);

  if (resolved === undefined || resolved === null) {
    return "";
  }

  return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
};

const loadPromptAssets = async (
  paths: WorkspacePaths,
  template: PromptTemplateName,
): Promise<{ template: string; fragments: Record<string, string> }> => {
  const templatePath = path.join(paths.projectRoot, TEMPLATE_PATHS[template]);
  const fragmentsDir = path.join(paths.projectRoot, FRAGMENTS_DIR);
  const fragmentEntries = (await fs.readdir(fragmentsDir)).filter((entry) => entry.endsWith(".md")).sort();

  const fragments = Object.fromEntries(
    await Promise.all(
      fragmentEntries.map(async (entry) => [entry.replace(/\.md$/, ""), await fs.readFile(path.join(fragmentsDir, entry), "utf8")]),
    ),
  );

  return {
    template: await fs.readFile(templatePath, "utf8"),
    fragments,
  };
};

const renderTemplate = (input: {
  template: string;
  fragments: Record<string, string>;
  context: Record<string, string>;
  fragmentAliases?: Record<string, string>;
  properties?: Record<string, unknown>;
}): string => {
  const renderFragments = (value: string): string =>
    value.replace(fragmentTokenPattern, (_match, rawName) => {
      const name = input.fragmentAliases?.[rawName] ?? rawName;
      const fragment = input.fragments[name];
      return fragment ? renderFragments(fragment) : "";
    });

  const withFragments = renderFragments(input.template);
  const withContext = withFragments.replace(contextTokenPattern, (_match, rawName) => input.context[rawName] ?? "");
  const withProperties = withContext.replace(propertyTokenPattern, (_match, rawScope, rawPath) =>
    resolveTemplateProperty(input.properties?.[rawScope], rawPath),
  );
  return `${withProperties.trim()}\n`;
};

export const renderPromptTemplate = async (input: {
  paths: WorkspacePaths;
  template: PromptTemplateName;
  context: Record<string, string>;
  fragmentAliases?: Record<string, string>;
  properties?: Record<string, unknown>;
}): Promise<string> => {
  const assets = await loadPromptAssets(input.paths, input.template);

  return renderTemplate({
    template: assets.template,
    fragments: assets.fragments,
    context: input.context,
    ...(input.fragmentAliases ? { fragmentAliases: input.fragmentAliases } : {}),
    ...(input.properties ? { properties: input.properties } : {}),
  });
};
