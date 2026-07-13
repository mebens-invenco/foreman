import path from "node:path";
import { promises as fs } from "node:fs";

import { describe, expect, test } from "vitest";

import { learningInjectionActionValues } from "../learning-injection-event-repo.js";
import { testProjectRoot } from "../../test-support/helpers.js";

const migrationPath = path.join(testProjectRoot, "migrations", "0032_learning_injection_event.sql");

/** The action set as the database enforces it, read back out of the CHECK constraint. */
const migrationActionCheckSet = async (): Promise<string[]> => {
  const migration = await fs.readFile(migrationPath, "utf8");
  const check = /action TEXT NOT NULL CHECK \(action IN \(([^)]+)\)\)/.exec(migration);
  if (!check) {
    throw new Error(`no action CHECK constraint found in ${migrationPath}`);
  }

  return check[1]!.split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
};

describe("learning injection action set", () => {
  /**
   * TypeScript derives the union from `learningInjectionActionValues`, so the seam
   * and the eligibility predicate cannot drift from it. The migration's CHECK is
   * the third restatement, and the only one the compiler cannot reach: widen the
   * union without widening the CHECK and every insert for the new action is
   * rejected — into a warning, because telemetry may never fail a render.
   */
  test("the migration CHECK enforces exactly the actions the code injects into", async () => {
    expect((await migrationActionCheckSet()).sort()).toEqual([...learningInjectionActionValues].sort());
  });
});
