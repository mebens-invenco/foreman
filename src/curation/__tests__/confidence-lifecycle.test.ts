import { describe, expect, test } from "vitest";

import type { LearningLifecycleRollup } from "../../repos/learning-usage-repo.js";
import { DECAY_WINDOW_DAYS, proposeConfidenceTransitions, USAGE_EPOCH } from "../confidence-lifecycle.js";

const NOW = new Date("2026-11-01T00:00:00.000Z");
/** Far enough before NOW that the 90-day epoch grace is always cleared. */
const OLD_EPOCH = new Date("2026-01-01T00:00:00.000Z");

const MS_PER_DAY = 86_400_000;
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();

const rollup = (
  overrides: Partial<LearningLifecycleRollup> & Pick<LearningLifecycleRollup, "learningId">,
): LearningLifecycleRollup => ({
  title: `Learning ${overrides.learningId}`,
  repo: "shared",
  confidence: "emerging",
  distinctTasksApplied: 0,
  distinctTasksRead: 0,
  createdAt: daysAgo(200),
  lastUsedAt: null,
  ...overrides,
});

const propose = (rollups: LearningLifecycleRollup[], epoch: Date = OLD_EPOCH) =>
  proposeConfidenceTransitions(rollups, NOW, epoch);

describe("confidence lifecycle promotion", () => {
  describe("when a learning has been applied by distinct tasks", () => {
    // A recent apply is implicit whenever distinctTasksApplied > 0, so these
    // promotion cases carry a fresh lastUsedAt and can never also be decay.
    const applied = (learningId: string, confidence: LearningLifecycleRollup["confidence"], distinctTasksApplied: number) =>
      rollup({ learningId, confidence, distinctTasksApplied, lastUsedAt: daysAgo(1) });

    test("emerging holds below the establish threshold and promotes at it", () => {
      expect(propose([applied("one", "emerging", 1)])).toEqual([]);
      expect(propose([applied("two", "emerging", 2)])).toMatchObject([
        { kind: "promote", learningId: "two", from: "emerging", to: "established", distinctTasksApplied: 2 },
      ]);
    });

    test("established holds below the proven threshold and promotes at it", () => {
      expect(propose([applied("three", "established", 3)])).toEqual([]);
      expect(propose([applied("four", "established", 4)])).toMatchObject([
        { kind: "promote", learningId: "four", from: "established", to: "proven", distinctTasksApplied: 4 },
      ]);
    });

    // Deliberate: confidence is a function of the evidence, not of how many passes
    // have run. Four distinct applies earn `proven` outright, so a single pass is
    // idempotent rather than inching one tier at a time.
    test("emerging with proven-level evidence jumps straight to proven in one pass", () => {
      expect(propose([applied("leap", "emerging", 4)])).toMatchObject([
        { kind: "promote", learningId: "leap", from: "emerging", to: "proven" },
      ]);
    });

    test("the pass only ever raises: it never demotes on thin evidence", () => {
      expect(propose([applied("estab", "established", 1), applied("prov", "proven", 0)])).toEqual([]);
    });
  });

  describe("when reads are plentiful but distinct applies are not", () => {
    // The input type carries no raw read_count/applied_count at all, so a rule
    // literally cannot read the inflated counters. distinctTasksRead is present
    // for display and is proven here to carry no promotion power.
    test("exposure is not endorsement — reads never promote", () => {
      expect(
        propose([rollup({ learningId: "read-heavy", confidence: "emerging", distinctTasksRead: 50, distinctTasksApplied: 1, lastUsedAt: daysAgo(1) })]),
      ).toEqual([]);
    });
  });
});

describe("confidence lifecycle decay", () => {
  describe("when an emerging learning has gone idle past the window", () => {
    test("a never-used learning older than the window decays", () => {
      expect(propose([rollup({ learningId: "silent", createdAt: daysAgo(120), lastUsedAt: null })])).toMatchObject([
        { kind: "decay", learningId: "silent", from: "emerging", idleDays: null },
      ]);
    });

    test("an injection-only learning still decays: being pushed and ignored is the signal", () => {
      // Injection never populates lastUsedAt, so injection-only history reaches the
      // rule as lastUsedAt: null — indistinguishable from never surfaced, by design.
      expect(propose([rollup({ learningId: "pushed", createdAt: daysAgo(200), lastUsedAt: null })])).toMatchObject([
        { kind: "decay", learningId: "pushed" },
      ]);
    });
  });

  describe("at the decay boundaries", () => {
    test("age: a learning younger than the window does not decay, one older does", () => {
      expect(propose([rollup({ learningId: "young", createdAt: daysAgo(89), lastUsedAt: null })])).toEqual([]);
      expect(propose([rollup({ learningId: "aged", createdAt: daysAgo(91), lastUsedAt: null })])).toMatchObject([
        { kind: "decay", learningId: "aged" },
      ]);
    });

    test("idleness: a recent read holds decay off, a stale one lets it through", () => {
      expect(propose([rollup({ learningId: "recent", createdAt: daysAgo(200), lastUsedAt: daysAgo(10) })])).toEqual([]);
      expect(propose([rollup({ learningId: "stale", createdAt: daysAgo(200), lastUsedAt: daysAgo(91) })])).toMatchObject([
        { kind: "decay", learningId: "stale", idleDays: 91 },
      ]);
    });

    // Age, idleness, and epoch grace are all `<=` — inclusive. At exactly now−90d
    // each check is an equality, so this pins the inclusive bound: flipping any of
    // the three `<=` to `<` drops this decay and fails the test.
    test("inclusive at the window edge: created, idle, and epoch all exactly a window old still decays", () => {
      const edge = daysAgo(DECAY_WINDOW_DAYS);
      const epochAtEdge = new Date(NOW.getTime() - DECAY_WINDOW_DAYS * MS_PER_DAY);
      expect(propose([rollup({ learningId: "edge", createdAt: edge, lastUsedAt: edge })], epochAtEdge)).toMatchObject([
        { kind: "decay", learningId: "edge" },
      ]);
    });
  });

  describe("epoch grace", () => {
    // Usage tracking only began at the epoch, so before epoch+window there is no
    // 90-day idle history to judge; nothing may decay however old the learning is.
    test("nothing decays before the usage epoch plus a full window, however old", () => {
      const recentEpoch = new Date(NOW.getTime() - 30 * MS_PER_DAY);
      expect(propose([rollup({ learningId: "old-but-safe", createdAt: daysAgo(300), lastUsedAt: null })], recentEpoch)).toEqual([]);
    });

    test("once a full window has elapsed since the epoch, decay is admitted", () => {
      const agedEpoch = new Date(NOW.getTime() - 91 * MS_PER_DAY);
      expect(propose([rollup({ learningId: "now-eligible", createdAt: daysAgo(300), lastUsedAt: null })], agedEpoch)).toMatchObject([
        { kind: "decay", learningId: "now-eligible" },
      ]);
    });

    test("the real usage epoch is the ENG-5701 provenance instant", () => {
      expect(USAGE_EPOCH).toBe("2026-07-14T00:00:00.000Z");
    });
  });

  describe("what decay never touches", () => {
    test("only emerging decays — established and proven never demote to archived", () => {
      expect(
        propose([
          rollup({ learningId: "estab", confidence: "established", createdAt: daysAgo(300), lastUsedAt: null }),
          rollup({ learningId: "prov", confidence: "proven", createdAt: daysAgo(300), lastUsedAt: null }),
        ]),
      ).toEqual([]);
    });

    test("promotion is decided first, so an earning learning is promoted, not decayed", () => {
      expect(
        propose([rollup({ learningId: "earned", confidence: "emerging", distinctTasksApplied: 2, createdAt: daysAgo(300), lastUsedAt: daysAgo(200) })]),
      ).toMatchObject([{ kind: "promote", learningId: "earned", to: "established" }]);
    });
  });
});
