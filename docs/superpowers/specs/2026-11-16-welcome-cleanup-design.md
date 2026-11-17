# Welcome cleanup after bans

Delete a banned member's automated welcome message without searching unrelated channels. Cleanup is optional and enabled by default, but requires an administrator to select the welcome bot and channel. The user approved collection followed by verification, and explicitly requested those selections.

## Experience

The existing server setup page adds a cleanup checkbox, a searchable bot picker showing bot names and avatars, and a searchable text-channel picker. Missing selections leave collection inactive. Administrators can clear or change either selection.

```mermaid
flowchart LR
    A[Server setup] --> B[Choose welcome bot and channel]
    B --> C[Save settings]
    C --> D[Collect message references]
    D --> E[Member banned]
    E --> F[Verify current candidate message]
    F --> G[Delete confirmed welcome]
    F --> H[Keep ambiguous candidate]
```

## Behavior

Collect image-bearing messages only from the configured bot and channel. Store references, timestamps, and available names of members who joined within two minutes of the message. No model call during collection. Store references in Postgres so restarts do not discard them. At ban time, also use the persisted member join date to find candidates when a join-time snapshot was unavailable.

After Discord confirms a ban, fetch candidates again, check their bot/channel against current configuration, and verify identity. An exclusive exact user mention is sufficient. For an image-only card, use the existing structured model client to extract the welcomed name, require high confidence and an exact normalized name match, and reject names shared by other contemporaneous joiners. Timing alone never authorizes deletion. Do not follow instructions in images or message content. Fetch images only from Discord-hosted current attachments/embeds. Cleanup failures do not affect ban handling.

## Approaches

Server-wide discovery and bot-specific setup instructions were rejected. Automatic observation without configured sources was considered, then replaced by the user's explicit bot/channel selection. Historical scanning and configuration agents are out of scope. Existing messages from before collection started are not covered. Model verification can miss cards, especially after a name change without a captured snapshot; ambiguous cards remain.
