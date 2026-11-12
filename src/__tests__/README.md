# Test data and setup

Keep a scenario's inputs, failure injection, race ordering and assertions visible in its test.
Use `it.each` when rows exercise the same contract. Keep different contracts as separate tests.

Reuse the repositories in `fakes/inMemoryRepositories.ts` for unit tests. Use real repositories
and the guarded disposable database for SQL atomicity and concurrency tests.

When setup repeats within one suite, start with a local factory. Return fresh mutable objects
and arrays on each call. Keep behavior-relevant differences explicit at the call site, such as
the confidence argument in `SecurityActionService.unit.test.ts`'s `buildDetection`.
Keep evidence-bearing detections inline when their content or source explains the scenario.

For repeated service wiring, expose only the collaborators the tests actually vary. Pass the
same repository instance that a race test spies on, as `buildSecurity` does in
`AutomaticModerationAttention.integration.test.ts`. Keep distinct wiring explicit rather than
adding options for every constructor argument. Move a helper into `fakes/` when another suite
needs the same contract, and keep assertions at the call site.
