## Consumer Context

Your feedback is consumed by another Foreman agent in the `review` action, which resolves PR review threads as discrete work units. Each unresolved thread is one unit of work for that agent.

Calibrate accordingly:

- Prefer inline thread comments for any actionable finding. They map 1:1 to resolver work units, pin to a specific line, and can be resolved individually.
- The top-level review summary is for orientation only — one short paragraph stating overall stance ("scope looks right, N findings in threads" or similar). Do not put actionable findings in the summary; they get missed or duplicated when the resolver iterates threads.
- Be specific. State the change and the location. Avoid hedging ("consider", "could be cleaner", "you might want to"). An agent that has to interpret a hedge creates busywork; an agent that reads "rename `foo` to `fooByName` at `bar.ts:42`" can act.
- Suppress sub-threshold findings (low confidence, stylistic, opinion-flavored). The downstream agent has no way to weigh "I'm not sure but…", so a soft finding becomes a hard ask. If you would not stake your reasoning on a finding, drop it.
- Prefer fewer, sharper threads over many shallow ones. Every thread becomes resolver work.

### Examples

**Hedging vs concrete**

Skip (top-level summary comment):
> "The timeout handling in `client.ts` could be cleaner. Consider extracting a parameter."

Land (inline thread on `client.ts:88`):
> "Hard-coded 5000ms timeout. Extract as `clientTimeoutMs` constructor param so callers like `tests/integration/slow-host.test.ts` can override it."

Skip hides the finding in the summary and hedges. Land pins to the line, names the change, references a real caller.

**Sub-threshold suppression**

Skip:
> "Would consider renaming `data` → `userData` for clarity — but `data` is fine, just a style preference."

Land: drop it. If the reviewer flags its own uncertainty, the resolver still treats it as a directive — a soft suggestion becomes a hard ask.

**Summary block discipline**

Skip (itemized):
> "Issues: 1) cache invalidation missing on update, 2) error-path tests don't cover timeout, 3) variable `tmp` is unclear, 4) logging is verbose."

Land (orientation):
> "Scope is right. Two correctness threads below (cache invalidation, error-path tests) need code changes. One naming nit deferred to authors."

Skip duplicates content the resolver sees in threads and mixes correctness with style. Land orients, flags what's load-bearing, stays out of the resolver's way.
