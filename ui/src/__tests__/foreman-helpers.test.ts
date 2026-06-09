import { describe, expect, test } from "vitest"

import type { ForemanTask } from "../lib/api"
import {
  agentLabelsOf,
  isAgentTagged,
  isInForemanScope,
  matchesFrontmatterFilter,
  matchesOnOffFilter,
} from "../pages/foreman/foreman-helpers"

function makeTask(overrides: Partial<ForemanTask> = {}): ForemanTask {
  return {
    id: "ENG-5386",
    title: "Foreman issue manager",
    state: "ready",
    providerState: "Todo",
    labels: ["agent:tars"],
    assignee: "Gerd Wittchen",
    url: "https://linear.app/invenco/issue/ENG-5386",
    agentEnabled: true,
    frontmatter: { state: "valid", repos: ["foreman"], detail: null },
    ...overrides,
  }
}

const INCLUDE_LABELS = ["agent:tars"]

describe("agentLabelsOf", () => {
  test("returns only configured include labels, ignoring the exclude label", () => {
    const task = makeTask({ labels: ["agent:tars", "agent:disabled", "bug"] })
    expect(agentLabelsOf(task, INCLUDE_LABELS)).toEqual(["agent:tars"])
  })

  test("falls back to the agent: prefix convention before settings resolve", () => {
    const task = makeTask({ labels: ["agent:michael", "chore"] })
    expect(agentLabelsOf(task, [])).toEqual(["agent:michael"])
  })
})

describe("isAgentTagged", () => {
  test("true when the task carries a configured agent label", () => {
    expect(isAgentTagged(makeTask(), INCLUDE_LABELS)).toBe(true)
  })

  test("false when only the exclude label is present", () => {
    const task = makeTask({ labels: ["agent:disabled"] })
    expect(isAgentTagged(task, INCLUDE_LABELS)).toBe(false)
  })
})

describe("isInForemanScope", () => {
  test("includes a ready-state issue even without an agent label", () => {
    const task = makeTask({ state: "ready", labels: ["bug"] })
    expect(isInForemanScope(task, INCLUDE_LABELS)).toBe(true)
  })

  test("includes a non-ready issue that carries an agent label", () => {
    const task = makeTask({ state: "in_progress", labels: ["agent:tars"] })
    expect(isInForemanScope(task, INCLUDE_LABELS)).toBe(true)
  })

  test("excludes a non-ready, untagged issue", () => {
    const task = makeTask({ state: "in_review", labels: ["bug"] })
    expect(isInForemanScope(task, INCLUDE_LABELS)).toBe(false)
  })
})

describe("matchesFrontmatterFilter", () => {
  test("'all' keeps every state", () => {
    for (const state of ["valid", "broken", "missing"] as const) {
      expect(matchesFrontmatterFilter(makeTask({ frontmatter: { state, repos: [], detail: null } }), "all")).toBe(true)
    }
  })

  test("'valid' keeps only valid", () => {
    expect(matchesFrontmatterFilter(makeTask({ frontmatter: { state: "valid", repos: ["foreman"], detail: null } }), "valid")).toBe(true)
    expect(matchesFrontmatterFilter(makeTask({ frontmatter: { state: "broken", repos: [], detail: "x" } }), "valid")).toBe(false)
  })

  test("'needs-fixing' keeps broken and missing, not valid", () => {
    expect(matchesFrontmatterFilter(makeTask({ frontmatter: { state: "broken", repos: [], detail: "x" } }), "needs-fixing")).toBe(true)
    expect(matchesFrontmatterFilter(makeTask({ frontmatter: { state: "missing", repos: [], detail: "x" } }), "needs-fixing")).toBe(true)
    expect(matchesFrontmatterFilter(makeTask({ frontmatter: { state: "valid", repos: ["foreman"], detail: null } }), "needs-fixing")).toBe(false)
  })
})

describe("matchesOnOffFilter", () => {
  test("'on' keeps enabled, 'off' keeps disabled, 'all' keeps both", () => {
    const on = makeTask({ agentEnabled: true })
    const off = makeTask({ agentEnabled: false })
    expect(matchesOnOffFilter(on, "on")).toBe(true)
    expect(matchesOnOffFilter(off, "on")).toBe(false)
    expect(matchesOnOffFilter(off, "off")).toBe(true)
    expect(matchesOnOffFilter(on, "off")).toBe(false)
    expect(matchesOnOffFilter(on, "all")).toBe(true)
    expect(matchesOnOffFilter(off, "all")).toBe(true)
  })
})
