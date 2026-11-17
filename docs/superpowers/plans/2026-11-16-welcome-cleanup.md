# Welcome cleanup implementation plan

> Implement natively in this session using the existing repository patterns.

**Goal:** Collect configured welcome-bot messages and delete verified matches after bans.

**Architecture:** One durable candidate table and repository, one collection/cleanup service, an extraction method on GPTService, and settings wired through the shared application schema and existing web setup form.

**Spec:** [Approved behavior](../specs/2026-11-16-welcome-cleanup-design.md).

## Tasks

- [x] Add optional default-enabled settings through schema, patches, fixtures, web form and searchable source selectors. Verify schema round trips, bot enumeration, and source validation.
- [x] Add candidate storage migration/repository, collect configured bot messages before the existing bot-message early return, and invoke cleanup from the confirmed Discord ban event. Verify restart-safe queries and exact source/time filtering.
- [x] Add structured welcome-name extraction to GPTService and deterministic final matching. Verify exact mentions bypass model work, image matches, ambiguous names, wrong sources, disabled/unconfigured settings, stale/missing messages, and provider/deletion failures.
- [x] Run formatting, compilation, focused tests, and broader checks appropriate to changed layers. Review the final diff and report any checks that could not run.

## Review focus

Simultaneous joins cannot authorize deleting another member's card. Configuration changes invalidate old source pairs. Failed image analysis keeps messages. Partial Discord reads preserve saved selections. Ban success is independent of cleanup success.
