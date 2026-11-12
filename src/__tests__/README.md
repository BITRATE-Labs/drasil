# Test data and setup

Keep a scenario's inputs, failure injection, race ordering and assertions visible in its test.
Use `it.each` when rows exercise the same contract. Keep different contracts as separate tests.

Reuse the repositories in `fakes/inMemoryRepositories.ts` for unit tests. Use real repositories
and the guarded disposable database for SQL atomicity and concurrency tests.

When setup repeats within one suite, start with a local factory. Return fresh mutable objects
and arrays on each call. Keep behavior-relevant differences explicit at the call site, such as
the confidence override in `SecurityActionService.unit.test.ts`'s `buildDetection`.
Keep evidence and source fields explicit when they explain the scenario.

For repeated service wiring, expose only the collaborators the tests actually vary. Pass the
same repository instance that a race test spies on, as `buildSecurity` does in
`AutomaticModerationAttention.integration.test.ts`. Keep distinct wiring explicit rather than
adding options for every constructor argument. Move a helper into `fakes/` when another suite
needs the same contract, and keep assertions at the call site.

Use named table rows to preserve each scenario's test name and decision-driving inputs.
Share assertions only when every row promises the same result. Keep recovery, race and
failure-order tests separate when their guarantees differ, even if their setup looks similar.

Named dependency overrides should follow the constructor's types and preserve omitted or
undefined dependencies. A fixture must not silently add working behavior to an intentionally
missing collaborator. Keep application adapters and session binding in the existing harness.

The notification and thread suites share `fakes/verificationEvents.ts` because their event
builders have identical defaults. It accepts only the fields it populates. Keep time overrides
explicit when a scenario depends on timestamps, and share another fixture only when its
existing values and missing fields mean the same thing to every caller.
