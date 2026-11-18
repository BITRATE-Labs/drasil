'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  PublicRestrictionAudit,
  RestrictionSelection,
  RestrictionApplyResult,
} from '@drasil/application';
import { ActionButton, DrasilBrand, Foundation } from '@/components/workspace/Foundation';
import { InboxActionRequestPollingProvider } from '@/components/inbox/InboxActionRequestPoller';
import type { ModerationActionRequestSummary } from '@/lib/moderationActionRequestDataAdapter';
import styles from './RestrictionAuditWizard.module.css';
export type RestrictionActionResult<T> = T | { readonly error: string };
export interface RestrictionReview {
  readonly reference: string;
  readonly fixes: PublicRestrictionAudit['fixes'];
  readonly expiresAt: string;
}
export interface RestrictionRequest {
  readonly id: string;
  readonly status: string;
  readonly lastError?: string | null;
  readonly restrictionApply?: RestrictionApplyResult;
  readonly restrictionEffectDescriptions?: readonly string[];
}
export interface RestrictionAuditWizardProps {
  readonly guildId: string;
  readonly auditRequest: RestrictionRequest | null;
  readonly audit: PublicRestrictionAudit | null;
  readonly applyRequest: RestrictionRequest | null;
  readonly onReview: (
    selection: RestrictionSelection
  ) => Promise<RestrictionActionResult<RestrictionReview>>;
  readonly onApply: (
    reference: string
  ) => Promise<RestrictionActionResult<{ readonly id: string; readonly status: string }>>;
  readonly onAudit?: () => Promise<
    RestrictionActionResult<{ readonly id: string; readonly status: string }>
  >;
  readonly onDiagnostics?: (
    offset: number
  ) => Promise<RestrictionActionResult<PublicRestrictionAudit | null>>;
  readonly exceptions?: readonly { readonly id: string; readonly name: string }[];
  readonly initialReview?: RestrictionReview;
}
export function selectableFixIds(audit: PublicRestrictionAudit): string[] {
  return audit.fixes
    .filter((f) => f.selectable && f.kind !== 'manual' && f.effects.length > 0)
    .map((f) => f.id);
}
function readable(value: string): string {
  return value.replace(/_/g, ' ');
}
export function RestrictionAuditWizard(props: RestrictionAuditWizardProps) {
  const { audit, guildId, auditRequest, applyRequest } = props;
  const [selected, setSelected] = useState<string[]>(
    () =>
      audit?.fixes
        .filter((f) => f.defaultSelected && selectableFixIds(audit).includes(f.id))
        .map((f) => f.id) ?? []
  );
  const [review, setReview] = useState<RestrictionReview | null>(props.initialReview ?? null);
  const [approved, setApproved] = useState(false);
  const [reviewExpired, setReviewExpired] = useState(false);
  useEffect(() => {
    const remaining = review ? Date.parse(review.expiresAt) - Date.now() : Infinity;
    setReviewExpired(remaining <= 0);
    if (!review || remaining <= 0) return;
    const timer = window.setTimeout(() => {
      setReviewExpired(true);
      setApproved(false);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [review]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState(audit);
  const heading = useRef<HTMLHeadingElement>(null);
  const auditKey = audit ? `${audit.auditRequestId}:${audit.revision}` : '';
  useEffect(() => {
    const defaults =
      audit?.fixes
        .filter((f) => f.defaultSelected && selectableFixIds(audit).includes(f.id))
        .map((f) => f.id) ?? [];
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem(`restriction-selection:${guildId}:${auditKey}`) ?? 'null'
      );
      setSelected(
        Array.isArray(saved) && audit
          ? saved.filter(
              (id): id is string => typeof id === 'string' && selectableFixIds(audit).includes(id)
            )
          : defaults
      );
    } catch {
      setSelected(defaults);
    }
    setReview(props.initialReview ?? null);
    setApproved(false);
    setDiagnostics(audit);
  }, [auditKey]); // A new audit always requires a new review.
  const changeSelection = (ids: string[]) => {
    setSelected(ids);
    try {
      sessionStorage.setItem(`restriction-selection:${guildId}:${auditKey}`, JSON.stringify(ids));
    } catch {
      /* Selection still works without browser storage. */
    }
    setReview(null);
    setApproved(false);
    setError(null);
  };
  const result = applyRequest?.restrictionApply;
  const busyRequest = [auditRequest, applyRequest].find(
    (r) => r?.status === 'queued' || r?.status === 'processing'
  );
  const selectedFixes = audit?.fixes.filter((f) => selected.includes(f.id)) ?? [];
  const unwrap = <T,>(result: RestrictionActionResult<T>): T => {
    if (result && typeof result === 'object' && 'error' in result) throw new Error(result.error);
    return result as T;
  };
  const navigateRequest = (key: string, id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set(key, id);
    if (key === 'audit') url.searchParams.delete('apply');
    window.location.assign(url.pathname + url.search);
  };
  async function run(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setReview(null);
      setApproved(false);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Request could not be completed. Run a fresh audit and review again.'
      );
    } finally {
      setPending(false);
    }
  }
  const attention = audit?.fixes.filter((f) => !selectableFixIds(audit).includes(f.id)) ?? [];
  const requests = [auditRequest, applyRequest].filter(Boolean) as ModerationActionRequestSummary[];
  return (
    <Foundation>
      <InboxActionRequestPollingProvider enabled={!!busyRequest} serverRequests={requests}>
        <div className={styles.layout}>
          <header className={styles.header}>
            <DrasilBrand href={`/admin/guild/${guildId}/operations`} />
            <a href={`/admin/guild/${guildId}/setup`}>Restriction settings</a>
          </header>
          <main className={styles.main}>
            <p className={styles.eyebrow}>Server protection</p>
            <h1 ref={heading} tabIndex={-1}>
              {result ? 'Update results' : review ? 'Review your changes' : 'Restriction setup'}
            </h1>
            <p className={styles.muted}>
              {result
                ? 'What changed, and what still needs attention.'
                : review
                  ? 'Check the changes and who they affect before you approve.'
                  : 'Keep restricted members in the right places.'}
            </p>
            <ol className={styles.steps} aria-label="Progress">
              {['Choose fixes', 'Review', 'Results'].map((s, i) => (
                <li key={s} aria-current={(result ? 2 : review ? 1 : 0) === i ? 'step' : undefined}>
                  <span>{i + 1}</span>
                  {s}
                </li>
              ))}
            </ol>
            {error && (
              <p role="alert" className={styles.attention}>
                {error} Run a fresh audit and review updated changes.
              </p>
            )}
            {busyRequest && (
              <p role="status">
                {applyRequest === busyRequest ? 'Applying selected changes' : 'Audit in progress'}.
                Request {busyRequest.id}. You can reload this page.
              </p>
            )}
            {!busyRequest && !audit && (
              <p role="status">
                {auditRequest
                  ? 'Audit unavailable. No permission verification is established.'
                  : 'Run a read-only audit to load suggested fixes.'}
              </p>
            )}
            {auditRequest?.status === 'failed' && (
              <p role="alert">
                Audit failed: {auditRequest.lastError ?? 'Evidence could not be loaded.'}
              </p>
            )}
            {applyRequest && !result && !busyRequest && (
              <p role="alert">
                Apply request {readable(applyRequest.status)}. No verified result is available.{' '}
                {applyRequest.lastError}
              </p>
            )}
            {result ? (
              <section aria-label="Results">
                <h2>
                  {result.stopReason === 'completed'
                    ? 'Selected batch finished'
                    : `Batch stopped: ${readable(result.stopReason)}`}
                </h2>
                <ul className={styles.results}>
                  {result.progress.receipts.map((r) => (
                    <li key={r.effectIndex}>
                      {applyRequest?.restrictionEffectDescriptions?.[r.effectIndex] ??
                        `Selected change ${r.effectIndex + 1}`}
                      : {readable(r.state)}
                      {r.error ? `. ${r.error}` : ''}
                    </li>
                  ))}
                </ul>
                <h2>Permission verification</h2>
                <p>Server setup: {readable(result.verification.setup.status)}</p>
                <ul>
                  {result.verification.cases.map((c) => (
                    <li key={c.caseId}>
                      Current case {c.caseId}: {readable(c.status)}
                    </li>
                  ))}
                </ul>
                <details className={styles.attention}>
                  <summary>Items still needing attention</summary>
                  <ul>
                    {result.verification.setup.findingCodes.map((code) => (
                      <li key={code}>Server setup: {readable(code)}</li>
                    ))}
                    {result.verification.cases.flatMap((c) =>
                      c.findingCodes.map((code) => (
                        <li key={`${c.caseId}:${code}`}>
                          Case {c.caseId}: {readable(code)}
                        </li>
                      ))
                    )}
                    {result.verification.setup.coverage
                      .filter((c) => c.state !== 'complete')
                      .map((c) => (
                        <li key={c.area}>
                          {readable(c.area)}: {readable(c.state)}. {c.reason}
                        </li>
                      ))}
                  </ul>
                </details>
                <p className={styles.muted}>
                  Recovery-parent message content was not inspected. Permission checks do not verify
                  information isolation.
                </p>
              </section>
            ) : review ? (
              <section className={styles.surface} aria-label="Review selected changes">
                <h2 className={styles.listHead}>Changes to apply</h2>
                <ul className={styles.reviewList}>
                  {review.fixes.map((f) => (
                    <li key={f.id}>
                      {f.summary}
                      <p>{f.after}</p>
                      <small>
                        Affected scope: {f.affectedScope.join(', ') || 'Selected targets'}.
                      </small>
                    </li>
                  ))}
                </ul>
                {reviewExpired && (
                  <p role="alert">
                    This review expired. Run a fresh audit and review the changes again.
                  </p>
                )}
                <label className={styles.consent}>
                  <input
                    type="checkbox"
                    checked={approved}
                    disabled={reviewExpired}
                    onChange={(e) => setApproved(e.target.checked)}
                  />
                  I approve these changes and their access effects.
                </label>
              </section>
            ) : (
              audit && (
                <section aria-label="Choose fixes">
                  <p className={styles.policy}>
                    Allowed access: Own case thread
                    {props.exceptions?.map((c) => (
                      <span key={c.id}> + #{c.name} (read-only)</span>
                    ))}
                  </p>
                  <div className={styles.surface}>
                    <div className={styles.listHead}>
                      <h2>Suggested fixes</h2>
                      <div className={styles.bulk} role="group" aria-label="Select changes">
                        <button
                          type="button"
                          onClick={() => changeSelection(selectableFixIds(audit))}
                        >
                          Select all
                        </button>
                        <button type="button" onClick={() => changeSelection([])}>
                          Clear all
                        </button>
                      </div>
                    </div>
                    {audit.fixes
                      .filter((f) => selectableFixIds(audit).includes(f.id))
                      .map((f) => (
                        <div
                          key={f.id}
                          className={styles.row}
                          data-selected={selected.includes(f.id)}
                        >
                          <label className={styles.choice}>
                            <input
                              type="checkbox"
                              checked={selected.includes(f.id)}
                              onChange={(e) =>
                                changeSelection(
                                  e.target.checked
                                    ? [...selected, f.id]
                                    : selected.filter((id) => id !== f.id)
                                )
                              }
                            />
                            <span>
                              <strong>{f.summary}</strong>
                              <small>
                                {f.kind === 'hardening' ? 'Optional hardening. ' : ''}
                                {f.affectedScope.join(', ') || 'Selected targets'}
                              </small>
                            </span>
                          </label>
                          <details>
                            <summary>What changes</summary>
                            <p>Before: {f.before}</p>
                            <p>After: {f.after}</p>
                            <p>Affected scope: {f.affectedScope.join(', ')}.</p>
                          </details>
                        </div>
                      ))}
                    {!selectableFixIds(audit).length && (
                      <p className={styles.empty}>
                        No automatic fixes proposed. Server setup is {audit.setup.status}.
                      </p>
                    )}
                  </div>
                  <details className={styles.attention}>
                    <summary>Items still needing attention</summary>
                    <ul>
                      {attention.map((f) => (
                        <li key={f.id}>
                          {f.summary}. {f.after}
                        </li>
                      ))}
                      {audit.coverage
                        .filter((c) => c.state !== 'complete')
                        .map((c) => (
                          <li key={c.area}>
                            {readable(c.area)}: {readable(c.state)}. {c.reason}
                          </li>
                        ))}
                      {diagnostics?.diagnostics.map((d, i) => (
                        <li key={`${d.code}:${i}`}>
                          {readable(d.code)}
                          {d.caseId ? `, case ${d.caseId}` : ''}
                          {d.channelId ? `, channel ${d.channelId}` : ''}
                        </li>
                      ))}
                    </ul>
                    {diagnostics?.nextDiagnosticOffset !== null && props.onDiagnostics && (
                      <button
                        type="button"
                        onClick={() =>
                          void run(async () => {
                            const next = unwrap(
                              await props.onDiagnostics!(diagnostics!.nextDiagnosticOffset!)
                            );
                            if (next) setDiagnostics(next);
                          })
                        }
                      >
                        More diagnostics
                      </button>
                    )}
                  </details>
                  <p className={styles.muted}>
                    Server setup: {audit.setup.status}. {audit.cases.length} current{' '}
                    {audit.cases.length === 1 ? 'case' : 'cases'} assessed. Recovery-parent message
                    content was not inspected.
                  </p>
                </section>
              )
            )}
            <div className={styles.auditActions}>
              {props.onAudit && (
                <ActionButton
                  disabled={pending || !!busyRequest}
                  onClick={() =>
                    void run(async () =>
                      navigateRequest('audit', unwrap(await props.onAudit!()).id)
                    )
                  }
                >
                  {audit ? 'Run fresh audit' : 'Run audit'}
                </ActionButton>
              )}
              <a href={`/admin/guild/${guildId}/setup`}>Edit read-only exception channels</a>
            </div>
          </main>
          {audit && !result && !busyRequest && (
            <footer className={styles.footer}>
              {review ? (
                <>
                  <ActionButton
                    disabled={pending}
                    onClick={() => {
                      setReview(null);
                      setApproved(false);
                      heading.current?.focus();
                    }}
                  >
                    Edit selection
                  </ActionButton>
                  <ActionButton
                    tone="positive"
                    disabled={!approved || pending || reviewExpired}
                    onClick={() =>
                      void run(async () => {
                        if (!approved || Date.parse(review.expiresAt) <= Date.now()) return;
                        navigateRequest('apply', unwrap(await props.onApply(review.reference)).id);
                      })
                    }
                  >
                    {pending ? 'Queueing changes' : 'Apply changes'}
                  </ActionButton>
                </>
              ) : (
                <>
                  <span aria-live="polite">
                    {selectedFixes.length} change{selectedFixes.length === 1 ? '' : 's'} selected
                  </span>
                  <ActionButton
                    tone="positive"
                    disabled={!selectedFixes.length || pending}
                    onClick={() =>
                      void run(async () => {
                        setApproved(false);
                        setReview(
                          unwrap(
                            await props.onReview({
                              auditRequestId: audit.auditRequestId,
                              auditRevision: audit.revision,
                              selectedFixIds: selected,
                            })
                          )
                        );
                        heading.current?.focus();
                      })
                    }
                  >
                    {pending ? 'Preparing review' : 'Review changes'}
                  </ActionButton>
                </>
              )}
            </footer>
          )}
        </div>
      </InboxActionRequestPollingProvider>
    </Foundation>
  );
}
