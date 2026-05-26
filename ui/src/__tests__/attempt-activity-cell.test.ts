import { describe, expect, test } from "vitest"

import { phaseToneClass } from "../components/attempt-status-summary"
import {
  TERMINAL_BADGE,
  terminalAttemptBadge,
} from "../pages/attempts/attempt-activity-cell"

describe("terminal attempt badge", () => {
  test("completed maps to finished phase (emerald) with Finished label", () => {
    const meta = terminalAttemptBadge("completed")
    expect(meta.label).toBe("Finished")
    expect(meta.phase).toBe("finished")
    expect(phaseToneClass[meta.phase]).toMatch(/emerald/)
  })

  test("failed maps to stuck phase (rose) with Failed label", () => {
    const meta = terminalAttemptBadge("failed")
    expect(meta.label).toBe("Failed")
    expect(meta.phase).toBe("stuck")
    expect(phaseToneClass[meta.phase]).toMatch(/rose/)
  })

  test("blocked maps to stuck phase (rose) with Blocked label", () => {
    const meta = terminalAttemptBadge("blocked")
    expect(meta.label).toBe("Blocked")
    expect(meta.phase).toBe("stuck")
    expect(phaseToneClass[meta.phase]).toMatch(/rose/)
  })

  test("canceled maps to suspicious phase (amber) with Canceled label", () => {
    const meta = terminalAttemptBadge("canceled")
    expect(meta.label).toBe("Canceled")
    expect(meta.phase).toBe("suspicious")
    expect(phaseToneClass[meta.phase]).toMatch(/amber/)
  })

  test("timed_out maps to suspicious phase (amber) with Timed out label", () => {
    const meta = terminalAttemptBadge("timed_out")
    expect(meta.label).toBe("Timed out")
    expect(meta.phase).toBe("suspicious")
    expect(phaseToneClass[meta.phase]).toMatch(/amber/)
  })

  test("every non-running attempt status has a terminal badge entry", () => {
    const statuses = ["completed", "failed", "blocked", "canceled", "timed_out"] as const
    for (const status of statuses) {
      expect(TERMINAL_BADGE[status]).toBeDefined()
      expect(TERMINAL_BADGE[status].label.length).toBeGreaterThan(0)
    }
  })

  test("non-completed terminal statuses do not render as green Finished badge", () => {
    const nonCompleted = ["failed", "blocked", "canceled", "timed_out"] as const
    for (const status of nonCompleted) {
      const meta = terminalAttemptBadge(status)
      expect(meta.label).not.toBe("Finished")
      expect(phaseToneClass[meta.phase]).not.toMatch(/emerald/)
    }
  })
})
