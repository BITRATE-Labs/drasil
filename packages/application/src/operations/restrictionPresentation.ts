import type { RestrictionAudit, RestrictionFinding } from './restrictionTypes';
export const RESTRICTION_DIAGNOSTIC_PAGE_SIZE = 50;
export interface RestrictionDiagnostic extends RestrictionFinding {
  readonly caseId: string | null;
  readonly caseRevision: string | null;
}
export type PublicRestrictionAudit = Omit<RestrictionAudit, 'facts' | 'cases' | 'setup'> & {
  readonly auditRequestId: string;
  readonly setup: Omit<RestrictionAudit['setup'], 'findings'>;
  readonly cases: readonly Omit<RestrictionAudit['cases'][number], 'findings' | 'coverage'>[];
  readonly diagnostics: readonly RestrictionDiagnostic[];
  readonly diagnosticOffset: number;
  readonly diagnosticTotal: number;
  readonly nextDiagnosticOffset: number | null;
};
/** Always retain every selectable fix, independently of diagnostic paging. */
export function projectRestrictionAudit(
  auditRequestId: string,
  audit: RestrictionAudit,
  diagnosticOffset = 0
): PublicRestrictionAudit {
  const { facts, cases, setup, ...summary } = audit;
  void facts;
  const { findings, ...setupSummary } = setup;
  const diagnostics: RestrictionDiagnostic[] = [
    ...findings.map((f) => ({ ...f, caseId: null, caseRevision: null })),
    ...cases.flatMap((c) =>
      c.findings.map((f) => ({ ...f, caseId: c.caseId, caseRevision: c.caseRevision }))
    ),
  ];
  const start = Math.max(0, Math.trunc(diagnosticOffset));
  const end = start + RESTRICTION_DIAGNOSTIC_PAGE_SIZE;
  return {
    ...summary,
    auditRequestId,
    setup: setupSummary,
    cases: cases.map((c) => ({
      caseId: c.caseId,
      caseRevision: c.caseRevision,
      userId: c.userId,
      status: c.status,
      findingCodes: c.findingCodes,
      scope: c.scope,
    })),
    diagnostics: diagnostics.slice(start, end),
    diagnosticOffset: start,
    diagnosticTotal: diagnostics.length,
    nextDiagnosticOffset: end < diagnostics.length ? end : null,
  };
}
