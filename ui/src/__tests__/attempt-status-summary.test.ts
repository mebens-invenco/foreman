import { describe, expect, test } from "vitest"

import {
  formatPhaseLabel,
  phaseToneClass,
} from "../components/attempt-status-summary"
import type { AttemptStatusPhase } from "../lib/api"

const phases: AttemptStatusPhase[] = [
  "not_started",
  "starting",
  "progressing",
  "suspicious",
  "stuck",
  "needs_human",
  "finished",
]

describe("attempt status summary tokens", () => {
  test("every phase has a tone class entry", () => {
    for (const phase of phases) {
      expect(phaseToneClass[phase]).toBeDefined()
      expect(phaseToneClass[phase]).toMatch(/border-/)
    }
  })

  test("status tones use the expected color families", () => {
    expect(phaseToneClass.progressing).toMatch(/sky/)
    expect(phaseToneClass.starting).toMatch(/sky/)
    expect(phaseToneClass.suspicious).toMatch(/amber/)
    expect(phaseToneClass.stuck).toMatch(/rose/)
    expect(phaseToneClass.needs_human).toMatch(/rose/)
    expect(phaseToneClass.finished).toMatch(/emerald/)
    expect(phaseToneClass.not_started).toMatch(/slate/)
  })

  test("formatPhaseLabel returns human-readable label", () => {
    expect(formatPhaseLabel("progressing")).toBe("Progressing")
    expect(formatPhaseLabel("needs_human")).toBe("Needs human")
    expect(formatPhaseLabel("not_started")).toBe("Not started")
  })
})
