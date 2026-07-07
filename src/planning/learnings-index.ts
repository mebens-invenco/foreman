import { markdownSection } from "../prompts/template-renderer.js";
import type { LearningRecord } from "../repos/learning-repo.js";

// Stable delimiters wrapping the rendered index in plan.md. The render side
// (render-plan-prompt.ts) emits them and the strip side (render-worker-prompt.ts)
// removes everything between them, so worker prompts never inherit the ~2-3K-token
// index. Both sides import these constants — the format has a single source and
// cannot silently drift.
export const LEARNINGS_INDEX_START = "<!-- learnings-index:start -->";
export const LEARNINGS_INDEX_END = "<!-- learnings-index:end -->";

// Above this many entries the full index stops being cheaper than targeted
// search, so we render the highest-signal slice and state the cut. This is a
// deliberate bridge until embedding-based retrieval lands (see ENG-5623).
export const LEARNINGS_INDEX_CAP = 300;

const CONFIDENCE_RANK: Record<LearningRecord["confidence"], number> = {
  proven: 0,
  established: 1,
  emerging: 2,
};

// Highest-confidence first, then most-recently-updated. This is both the
// display order and the order truncation keeps, so a cut is a clean prefix.
const byConfidenceThenRecency = (left: LearningRecord, right: LearningRecord): number => {
  const rank = CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence];
  if (rank !== 0) {
    return rank;
  }
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }
  return left.id.localeCompare(right.id);
};

// Keep every cell on one table row: escape pipes and collapse any whitespace.
const formatCell = (value: string): string => value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();

const renderRow = (learning: LearningRecord): string =>
  `| ${formatCell(learning.id)} | ${formatCell(learning.title)} | ${formatCell(learning.repo)} | ${formatCell(learning.confidence)} | ${formatCell(learning.tags.join(", "))} |`;

const renderIndexBody = (learnings: LearningRecord[]): string => {
  const ordered = [...learnings].sort(byConfidenceThenRecency);
  const shown = ordered.slice(0, LEARNINGS_INDEX_CAP);
  const omitted = ordered.length - shown.length;

  if (shown.length === 0) {
    return "_No workspace learnings have been recorded yet._";
  }

  const lines = ["| id | title | repo | confidence | tags |", "| --- | --- | --- | --- | --- |", ...shown.map(renderRow)];

  if (omitted > 0) {
    lines.push(
      "",
      `_Showing the top ${LEARNINGS_INDEX_CAP} of ${ordered.length} learnings by confidence then recency; ${omitted} omitted. Use \`foreman learnings search\` to reach the rest._`,
    );
  }

  return lines.join("\n");
};

// Render the marker-wrapped "Workspace Learnings Index" section for plan.md. A
// compact table (id/title/repo/confidence/tags) lets planners shortlist from
// titles instead of guessing FTS terms, then fetch bodies with `learnings get`.
export const renderLearningsIndexSection = (learnings: LearningRecord[]): string =>
  [LEARNINGS_INDEX_START, markdownSection("Workspace Learnings Index", renderIndexBody(learnings)), LEARNINGS_INDEX_END].join("\n");

// Markers contain no regex-special characters, so they compose into the pattern
// directly. Trailing newlines are consumed so stripping leaves no blank gap.
const learningsIndexPattern = new RegExp(`${LEARNINGS_INDEX_START}[\\s\\S]*?${LEARNINGS_INDEX_END}\\n*`, "g");

// Remove the index section (markers included) from a rendered plan so worker
// prompts embed the plan without the index. A plan with no markers is unchanged.
export const stripLearningsIndex = (planMarkdown: string): string => planMarkdown.replace(learningsIndexPattern, "");
