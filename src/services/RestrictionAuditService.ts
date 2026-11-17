import { randomUUID } from 'crypto';
import {
  assessRestrictionFacts,
  proposeRestrictionFixes,
  RESTRICTION_PLAN_TTL_MS,
  type RestrictionAudit,
  type RestrictionCaseFact,
  type RestrictionFacts,
  type RestrictionThreadFact,
} from '@drasil/application';

export interface RestrictionPage<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}
export interface RestrictionAuditReadPort {
  readBase(guildId: string): Promise<RestrictionFacts>;
  readCases(
    guildId: string,
    cursor: string | null,
    limit: number
  ): Promise<RestrictionPage<RestrictionCaseFact>>;
  readMember(guildId: string, item: RestrictionCaseFact): Promise<RestrictionCaseFact>;
  readThreads(
    guildId: string,
    cursor: string | null,
    limit: number
  ): Promise<RestrictionPage<RestrictionThreadFact>>;
  readThreadMembers(
    guildId: string,
    threadId: string,
    cursor: string | null,
    limit: number
  ): Promise<RestrictionPage<string>>;
}
export interface IRestrictionAuditService {
  auditGuild(guildId: string): Promise<RestrictionAudit>;
}

const AUDIT_DEADLINE_MS = 90_000;
const CONCURRENCY = 2;

/** Worker-owned, read-only collection. Never infer completeness from a bounded sample. */
export class RestrictionAuditService implements IRestrictionAuditService {
  public constructor(
    private readonly read: RestrictionAuditReadPort,
    private readonly now: () => Date = () => new Date(),
    private readonly deadlineMs = AUDIT_DEADLINE_MS
  ) {}

  public async auditGuild(guildId: string): Promise<RestrictionAudit> {
    const started = this.now();
    const deadline = started.getTime() + this.deadlineMs;
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
      const remaining = deadline - this.now().getTime();
      if (remaining <= 0) throw new Error('Audit deadline exhausted');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Audit deadline exhausted')), remaining);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    let facts: RestrictionFacts;
    try {
      facts = await bounded(() => this.read.readBase(guildId));
    } catch {
      facts = {
        guildId,
        caseRoleId: null,
        quarantineMode: 'off',
        exemptRoleIds: [],
        manualIntakeRoleId: null,
        botHighestPosition: null,
        roles: [],
        observedAt: started.toISOString(),
        completedAt: started.toISOString(),
        channels: [],
        channelsComplete: false,
        cases: [],
        casesComplete: false,
        threads: [],
        threadsComplete: false,
        exceptionChannelIds: [],
        recoveryParentId: null,
        knownParentContentExposure: false,
      };
    }
    const pages = async <T>(
      read: (cursor: string | null) => Promise<RestrictionPage<T>>
    ): Promise<{ items: T[]; complete: boolean }> => {
      const items: T[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      try {
        do {
          const page = await bounded(() => read(cursor));
          items.push(...page.items);
          cursor = page.next;
          if (cursor && seen.has(cursor)) throw new Error('Repeated pagination cursor');
          if (cursor) seen.add(cursor);
        } while (cursor);
        return { items, complete: true };
      } catch {
        return { items, complete: false };
      }
    };
    const [cases, threads] = await Promise.all([
      pages((cursor) => this.read.readCases(guildId, cursor, 50)),
      pages((cursor) => this.read.readThreads(guildId, cursor, 100)),
    ]);
    // Bound every Discord fan-out, including member reads and thread-membership pagination.
    for (let index = 0; index < cases.items.length; index += CONCURRENCY) {
      await Promise.all(
        cases.items.slice(index, index + CONCURRENCY).map(async (item, offset) => {
          try {
            cases.items[index + offset] = await bounded(() => this.read.readMember(guildId, item));
          } catch {
            cases.items[index + offset] = { ...item, metadataAvailable: false };
          }
        })
      );
    }
    for (let index = 0; index < threads.items.length; index += CONCURRENCY) {
      await Promise.all(
        threads.items.slice(index, index + CONCURRENCY).map(async (item, offset) => {
          if (!item.private) return;
          const members = await pages((cursor) =>
            this.read.readThreadMembers(guildId, item.id, cursor, 100)
          );
          threads.items[index + offset] = {
            ...item,
            memberIds: members.items,
            metadataAvailable: item.metadataAvailable && members.complete,
          };
          if (!members.complete) threads.complete = false;
        })
      );
    }
    facts = {
      ...facts,
      observedAt: started.toISOString(),
      completedAt: this.now().toISOString(),
      cases: cases.items,
      casesComplete: cases.complete,
      threads: [...new Map(threads.items.map((t) => [t.id, t])).values()],
      threadsComplete: threads.complete,
    };
    const assessment = assessRestrictionFacts(facts);
    const coverage = assessment.setup.coverage.map((c) =>
      c.area === 'affected_members'
        ? {
            ...c,
            checked: facts.cases.filter((item) => item.metadataAvailable).length,
            total: facts.casesComplete ? facts.cases.length : null,
            state:
              facts.casesComplete && facts.cases.every((item) => item.metadataAvailable)
                ? ('complete' as const)
                : facts.cases.some((item) => item.metadataAvailable)
                  ? ('partial' as const)
                  : ('unavailable' as const),
            reason:
              facts.casesComplete && facts.cases.every((item) => item.metadataAvailable)
                ? null
                : 'Required member metadata unavailable',
          }
        : c
    );
    const missingMember = coverage.some(
      (c) => c.area === 'affected_members' && c.state !== 'complete'
    );
    const setup = {
      ...assessment.setup,
      coverage,
      status:
        missingMember && assessment.setup.status === 'verified'
          ? ('unverified' as const)
          : assessment.setup.status,
    };
    return {
      schemaVersion: 1,
      guildId,
      observedAt: facts.observedAt,
      completedAt: facts.completedAt,
      revision: randomUUID(),
      expiresAt: new Date(started.getTime() + RESTRICTION_PLAN_TTL_MS).toISOString(),
      setup,
      cases: [...assessment.cases],
      coverage,
      fixes: [...proposeRestrictionFixes(facts, { ...assessment, setup })],
      facts,
    };
  }
}
