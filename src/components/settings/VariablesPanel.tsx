import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { Translate } from '../common/copy';
import { ActionButton, Banner, Card, useInputStyle } from '../common/ui';

/**
 * The application variables, editable (FR-CON-3, NFR-M1).
 *
 * **This screen exists because our own settings surface removed the platform's
 * one.** `defineSettingsFrontComponent` replaces Twenty's variable editor
 * instead of sitting beside it, so every variable the app declares became a
 * constant the moment this app shipped a settings tab — including the opt-out
 * confirmation, whose whole reason for being a variable is that counsel can
 * reword it without a deploy. The Diagnostics tab even sent the operator to a
 * "Variables" tab that no longer existed.
 *
 * ---
 *
 * **One flat list with a Save button per row became one grouped list with a
 * single Save** (D-68). The per-row buttons were an argument — that changing a
 * retention window and changing legal wording should not be the same action —
 * and the argument was right about the risk and wrong about the remedy. Twenty
 * settings in undifferentiated sequence, each with its own button, is a screen
 * where nobody can find the one they came for, and where editing three means
 * three round trips and three chances to forget one.
 *
 * What the per-row buttons were protecting is kept, and made explicit instead:
 *
 * - **Sections**, so a variable is found by what it is about rather than by
 *   reading twenty keys.
 * - **The bar names what it will change** — "Save 2 changes" with the keys
 *   listed — so committing legal wording alongside a throttle is a thing an
 *   operator sees rather than a thing that happens to them.
 * - **Every save is still one request per variable**, because that is the
 *   route's shape; a partial failure leaves the ones that failed dirty and on
 *   screen with their text intact.
 */

export type EditableVariable = {
  key: string;
  value: string;
  description: string;
  type: string;
  options: unknown;
};

type SelectOption = { label: string; value: string };

const optionsOf = (options: unknown): SelectOption[] =>
  Array.isArray(options)
    ? options.flatMap((option) => {
        const entry = option as { label?: unknown; value?: unknown };

        return typeof entry?.value === 'string'
          ? [{ label: String(entry.label ?? entry.value), value: entry.value }]
          : [];
      })
    : [];

/**
 * Which section a variable belongs to, decided by the thing it affects.
 *
 * Matched in order and by prefix, because the names already carry the grouping
 * — `WA_OPT_OUT_*` and `WA_CONFIRMATION_*` are one subject — and a hand-written
 * list of every key would fall out of date the first time one was added. The
 * fallthrough is a real section rather than a silent drop: a variable with no
 * home must still be editable, or adding one quietly makes it invisible.
 */
export const SECTIONS = [
  {
    key: 'connection',
    prefixes: ['META_', 'WA_PROVIDER', 'WA_WEBHOOK_'],
  },
  {
    key: 'sending',
    prefixes: [
      'WA_SEND_',
      'WA_INTERACTIVE_LANE',
      'WA_RECIPIENT_',
      'WA_DEFAULT_COUNTRY_',
    ],
  },
  { key: 'window', prefixes: ['WA_SERVICE_WINDOW', 'WA_FEP_WINDOW', 'WA_AUTO_CLOSE'] },
  {
    key: 'consent',
    prefixes: ['WA_OPT_IN_', 'WA_OPT_OUT_', 'WA_CONFIRMATION_'],
  },
  { key: 'campaigns', prefixes: ['WA_CAMPAIGN_'] },
  { key: 'templates', prefixes: ['WA_TEMPLATE_'] },
  { key: 'media', prefixes: ['WA_MEDIA_'] },
  { key: 'retention', prefixes: ['WA_RETENTION_', 'WA_TIMELINE_'] },
  { key: 'billing', prefixes: ['WA_RATE_'] },
  { key: 'interface', prefixes: ['WA_POLL_INTERVAL_', 'WA_TIME_ZONE'] },
  { key: 'access', prefixes: ['WA_ALLOW_'] },
  { key: 'other', prefixes: [] },
] as const;

export type SectionKey = (typeof SECTIONS)[number]['key'];

export const sectionOf = (key: string): SectionKey =>
  SECTIONS.find(
    (section) =>
      section.prefixes.length > 0 &&
      section.prefixes.some((prefix) => key.startsWith(prefix)),
  )?.key ?? 'other';

/** The variables of each section, in declaration order, empty sections dropped. */
export const groupVariables = (
  variables: EditableVariable[],
): { key: SectionKey; variables: EditableVariable[] }[] =>
  SECTIONS.map((section) => ({
    key: section.key,
    variables: variables.filter((variable) => sectionOf(variable.key) === section.key),
  })).filter((section) => section.variables.length > 0);

/**
 * The keys whose draft differs from what the server holds.
 *
 * Pure and exported because it is what the bar counts, what Save iterates, and
 * what the "unsaved changes" state is — three readers of one rule, which is
 * exactly the kind of thing that drifts when it is written three times.
 */
export const dirtyKeys = (
  variables: EditableVariable[],
  drafts: Record<string, string>,
): string[] =>
  variables
    .filter(
      (variable) =>
        drafts[variable.key] !== undefined && drafts[variable.key] !== variable.value,
    )
    .map((variable) => variable.key);

const VariableRow = ({
  variable,
  draft,
  onChange,
  t,
}: {
  variable: EditableVariable;
  draft: string;
  onChange: (value: string) => void;
  t: Translate;
}) => {
  const theme = useTheme();
  const inputStyle = useInputStyle();

  const dirty = draft !== variable.value;
  const choices = optionsOf(variable.options);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[1],
        borderTop: `1px solid ${theme.border.color.light}`,
        paddingTop: theme.spacing[2],
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: theme.spacing[2],
          fontSize: theme.font.size.md,
          fontWeight: theme.font.weight.semiBold,
          fontFamily: theme.font.family,
        }}
      >
        {variable.key}
        {/*
          The mark that survives scrolling past the bar. A count in a footer
          says how many are unsaved; this says which.
        */}
        {dirty ? (
          <span
            style={{
              fontSize: theme.font.size.xs,
              fontWeight: theme.font.weight.regular,
              color: theme.font.color.tertiary,
            }}
          >
            {t('settings.variableEdited')}
          </span>
        ) : null}
      </span>
      <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}>
        {variable.description}
      </span>

      <div style={{ display: 'flex', gap: theme.spacing[2], alignItems: 'flex-start' }}>
        {variable.type === 'BOOLEAN' ? (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: theme.spacing[1],
              fontSize: theme.font.size.md,
              color: theme.font.color.secondary,
            }}
          >
            <input
              type="checkbox"
              checked={draft === 'true'}
              aria-label={variable.key}
              onChange={(event) => onChange(event.target.checked ? 'true' : 'false')}
            />
            {t(draft === 'true' ? 'common.yes' : 'common.no')}
          </label>
        ) : choices.length > 0 ? (
          <select
            value={draft}
            aria-label={variable.key}
            onChange={(event) => onChange(event.target.value)}
            style={{
              ...inputStyle,
              flex: '1 1 auto',
              borderColor: dirty ? theme.color.blue : undefined,
            }}
          >
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        ) : (
          /**
           * A textarea for everything else, including the arrays and the
           * confirmation sentences. The confirmations run to two lines and the
           * keyword lists are stored as JSON, and a single-line input turns
           * both into a horizontal scroll.
           */
          <textarea
            value={draft}
            aria-label={variable.key}
            rows={draft.length > 60 ? 3 : 1}
            onChange={(event) => onChange(event.target.value)}
            style={{
              ...inputStyle,
              flex: '1 1 auto',
              resize: 'vertical',
              borderColor: dirty ? theme.color.blue : undefined,
            }}
          />
        )}
      </div>
    </div>
  );
};

export const VariablesPanel = ({
  variables,
  busy,
  t,
  onSave,
}: {
  variables: EditableVariable[];
  busy: boolean;
  t: Translate;
  /** One request per variable, because that is the route's shape. */
  onSave: (key: string, value: string) => Promise<boolean>;
}) => {
  const theme = useTheme();

  const [drafts, setDrafts] = useState<Record<string, string>>({});

  /**
   * The server's values win whenever they change — a save returns the whole
   * set, and someone else's edit must not be masked by a stale draft.
   *
   * Drafts the operator is still editing are kept. A reload that discarded
   * unsaved typing would be the worst possible response to a background poll,
   * and the only drafts dropped are the ones the server now agrees with.
   */
  useEffect(() => {
    setDrafts((current) =>
      Object.fromEntries(
        variables.map((variable) => {
          const draft = current[variable.key];

          return [
            variable.key,
            draft === undefined || draft === variable.value ? variable.value : draft,
          ];
        }),
      ),
    );
  }, [variables]);

  const groups = useMemo(() => groupVariables(variables), [variables]);
  const dirty = useMemo(() => dirtyKeys(variables, drafts), [variables, drafts]);

  const saveAll = useCallback(async () => {
    /**
     * Sequential, not concurrent. Each save answers with the whole variable
     * set, so parallel writes would race each other's responses and the last
     * one home would decide what the screen shows.
     */
    for (const key of dirty) {
      const value = drafts[key];

      if (value === undefined) continue;

      // A refused save stops the run: the rest stay dirty and on screen with
      // their text intact, and the banner says what went wrong.
      if (!(await onSave(key, value))) return;
    }
  }, [dirty, drafts, onSave]);

  const discardAll = useCallback(() => {
    setDrafts(Object.fromEntries(variables.map((v) => [v.key, v.value])));
  }, [variables]);

  return (
    <>
      <Card title={t('settings.tab.variables')}>
        <Banner>{t('settings.variablesNote')}</Banner>

        {variables.length === 0 ? <Banner>{t('common.loading')}</Banner> : null}
      </Card>

      {groups.map((group) => (
        <Card key={group.key} title={t(`settings.variableSection.${group.key}`)}>
          {group.variables.map((variable) => (
            <VariableRow
              key={variable.key}
              variable={variable}
              draft={drafts[variable.key] ?? variable.value}
              onChange={(value) =>
                setDrafts((current) => ({ ...current, [variable.key]: value }))
              }
              t={t}
            />
          ))}
        </Card>
      ))}

      {/*
        One bar, pinned to the bottom of the scrolling pane, and only while
        there is something to save (D-68).

        It **names the keys**, which is the part that is not decoration: a
        single Save that commits a throttle and a legal sentence together is
        only acceptable if the operator can see that is what it is about to do.
        `position: sticky` rather than `fixed`: this component lives inside a
        host-controlled settings pane, and a fixed bar would float over the
        whole CRM.
      */}
      {dirty.length === 0 ? null : (
        <div
          role="status"
          style={{
            position: 'sticky',
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing[2],
            flexWrap: 'wrap',
            border: `1px solid ${theme.border.color.medium}`,
            borderRadius: theme.border.radius.md,
            background: theme.background.secondary,
            padding: theme.spacing[2],
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 200px' }}>
            <span style={{ fontSize: theme.font.size.md, color: theme.font.color.primary }}>
              {t('settings.unsavedChanges', { count: dirty.length })}
            </span>
            <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
              {dirty.join(', ')}
            </span>
          </div>

          <ActionButton label={t('common.cancel')} onClick={discardAll} disabled={busy} />
          <ActionButton
            label={t('settings.saveChanges', { count: dirty.length })}
            tone="primary"
            busy={busy}
            onClick={() => void saveAll()}
          />
        </div>
      )}
    </>
  );
};
