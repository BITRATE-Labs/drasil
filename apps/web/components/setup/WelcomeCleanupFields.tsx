'use client';

import { useId, useState } from 'react';

export interface WelcomeSourceOption {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl?: string | null;
  readonly detail?: string;
}
function SourcePicker({
  label,
  name,
  options,
  savedId,
}: {
  readonly label: string;
  readonly name: string;
  readonly options: readonly WelcomeSourceOption[];
  readonly savedId: string | null;
}) {
  const id = useId();
  const [selected, setSelected] = useState(savedId ?? '');
  const [search, setSearch] = useState('');
  const current = options.find((option) => option.id === selected);
  const filtered = options.filter((option) =>
    `${option.name} ${option.detail ?? ''}`.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div className="field">
      <label id={`${id}-label`}>{label}</label>
      <input type="hidden" name={name} value={selected} />
      <details className="welcome-source-picker">
        <summary aria-labelledby={`${id}-label ${id}-value`}>
          <span id={`${id}-value`}>
            {current?.name ??
              (selected ? `Saved selection (${selected})` : `Choose ${label.toLowerCase()}`)}
          </span>
        </summary>
        <label htmlFor={`${id}-search`}>Search {label.toLowerCase()}</label>
        <input
          id={`${id}-search`}
          type="search"
          placeholder={`Search ${label.toLowerCase()}...`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="welcome-source-options" role="group" aria-label={`${label} options`}>
          <button type="button" aria-pressed={!selected} onClick={() => setSelected('')}>
            None
          </button>
          {filtered.map((option) => (
            <button
              type="button"
              key={option.id}
              aria-pressed={selected === option.id}
              onClick={(event) => {
                setSelected(option.id);
                setSearch('');
                event.currentTarget.closest('details')?.removeAttribute('open');
                event.currentTarget.closest('details')?.querySelector('summary')?.focus();
              }}
            >
              {option.avatarUrl ? (
                <img src={option.avatarUrl} alt="" width={32} height={32} />
              ) : null}
              <span>
                {option.name}
                {option.detail ? <small className="muted"> {option.detail}</small> : null}
              </span>
            </button>
          ))}
          {!filtered.length ? (
            <p className="muted" role="status">
              No matching {label.toLowerCase()} found.
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );
}
export function WelcomeCleanupFields({
  enabled,
  botId,
  channelId,
  bots,
  channels,
  botsUnavailable = false,
}: {
  readonly enabled: boolean;
  readonly botId: string | null;
  readonly channelId: string | null;
  readonly bots: readonly WelcomeSourceOption[];
  readonly channels: readonly WelcomeSourceOption[];
  readonly botsUnavailable?: boolean;
}) {
  return (
    <section aria-labelledby="welcome-cleanup-title">
      <h2 id="welcome-cleanup-title">Welcome cleanup</h2>
      <p className="muted">
        Remove confirmed welcome messages when a member is banned. Choose the bot and channel to
        start collecting candidates. Messages from before setup are not included.
      </p>
      <label>
        <input type="checkbox" name="welcomeCleanupEnabled" defaultChecked={enabled} /> Delete
        welcome messages after bans
      </label>
      <div className="form-grid">
        <SourcePicker
          label="Welcome bot"
          name="welcomeCleanupBotId"
          options={bots}
          savedId={botId}
        />
        <SourcePicker
          label="Welcome channel"
          name="welcomeCleanupChannelId"
          options={channels}
          savedId={channelId}
        />
      </div>
      {botsUnavailable ? (
        <p role="status">
          The bot list could not be loaded. Your saved selection is preserved. Reload to try again.
        </p>
      ) : null}
      <p className="muted">
        Drasil needs View Channel, Read Message History, and Manage Messages in the welcome channel.
        Uncertain matches are kept.
      </p>
    </section>
  );
}
