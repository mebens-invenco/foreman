import type { ReviewCommentAttribution } from "../review-service.js";

const modelFamilies = ["fable", "opus", "sonnet", "haiku", "sol", "terra", "luna"] as const;

const normalizeLabel = (label: string): string => {
  const trimmed = label.trim();
  const bracketed = trimmed.match(/^\[(.*)]$/s);
  return bracketed?.[1]?.trim() || trimmed;
};

const encodeBadgeText = (value: string): string =>
  encodeURIComponent(value.replaceAll("_", "__").replaceAll("-", "--").replaceAll(" ", "_"));

const escapeAltText = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");

const abbreviatedModel = (model: string): string => {
  const parts = model.toLowerCase().split(/[^a-z0-9]+/);
  return modelFamilies.find((family) => parts.includes(family)) ?? model.split("/").at(-1)!;
};

const badgeBrand = (
  attribution: ReviewCommentAttribution,
): { logo: string; labelColor: string } | null => {
  if (attribution.runnerName === "claude") {
    return { logo: "claude", labelColor: "D97757" };
  }
  if (attribution.runnerName === "opencode") {
    return { logo: "opencode", labelColor: "1A1A1A" };
  }
  return null;
};

const badgeMarkdown = (attribution: ReviewCommentAttribution): string => {
  const label = normalizeLabel(attribution.label);
  const alt = escapeAltText(`${label} | ${attribution.runnerName} | ${attribution.runnerModel}`);
  const brand = badgeBrand(attribution);
  const query = brand ? `?logo=${brand.logo}&logoColor=white&labelColor=${brand.labelColor}` : "";
  const url = `https://img.shields.io/badge/${encodeBadgeText(abbreviatedModel(attribution.runnerModel))}-${encodeBadgeText(label)}-555${query}`;
  return `![${alt}](${url})`;
};

export const isGitHubAgentComment = (body: string, label: string): boolean => {
  const altPrefix = `![${escapeAltText(normalizeLabel(label))} | `;
  const imageEnd = body.indexOf("](https://img.shields.io/badge/");
  return body.startsWith(altPrefix) && imageEnd >= altPrefix.length;
};

export const formatGitHubAgentComment = (body: string, attribution: ReviewCommentAttribution): string => {
  if (isGitHubAgentComment(body, attribution.label)) {
    return body;
  }

  const unprefixedBody = body.startsWith(attribution.label) ? body.slice(attribution.label.length) : body;
  return `${badgeMarkdown(attribution)}\n\n${unprefixedBody}`;
};
