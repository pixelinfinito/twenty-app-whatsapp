import { useMemo, useRef, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import {
  bodyVariableHints,
  buttonLabels,
  buttonVariableHints,
  headerVariableHints,
  mediaHeaderOf,
} from '../../domain/template-hints';
import {
  emptyParameters,
  isBlank,
  renderTemplate,
  validateParameters,
  type ResolvedParameters,
} from '../../domain/template-render';
import type { VariableSpec } from '../../domain/template-spec';
import { FileUpload } from './builders/FileUpload';
import type { SelectedFile } from './builders/upload';
import { mediaKindForHeaderFormat } from '../../domain/media-limits';
import type { Translate } from '../common/copy';
import { Glyph } from '../common/icons';
import type { FeedTemplate } from '../common/use-feed';

/**
 * Choosing a template and filling it in (FR-TPL-3, specs/08 §3.3).
 *
 * The preview is rendered by `renderTemplate` — the *same* pure function the
 * campaign snapshot and the send path use. A picker with its own placeholder
 * substitution would eventually show a rep something different from what the
 * customer receives, and the difference would only be discovered by the
 * customer.
 *
 * `validateParameters` decides when **Enviar** is available, for the same
 * reason: Meta rejects a template with an empty parameter, so the rule that
 * excludes a campaign recipient is the rule that disables this button.
 *
 * The list is already filtered server-side to published, usable, approved
 * templates (FR-TPL-2) — nothing here re-derives that.
 *
 * ---
 *
 * **What this form got wrong, and what fixed it.** Sending a six-variable
 * template meant six boxes labelled `{{1}}` … `{{6}}`, a preview below the fold
 * that still read `{{1}}`, and Send and Cancel scrolled off the bottom of the
 * pane — with the conversation itself pushed entirely out of view. A rep had to
 * guess what `{{4}}` was, could not see whether they had guessed right, and
 * could not reach the button that would tell them.
 *
 * Four changes, and each answers one of those:
 *
 * - **Every field is labelled with the words around it.** `📅 Data: {{4}}
 *   (hora de Luanda)` is the label; Meta's own synced example is the input's
 *   placeholder (`template-hints.ts`). None of that is new data — the picker
 *   simply never read it.
 * - **The preview updates as you type**, sits above the fields where a reader
 *   looks first, and draws the buttons the body refers to.
 * - **The header and the footer are pinned**, so the template being edited and
 *   the two actions are visible from any scroll position. Only the middle
 *   scrolls.
 * - **A missing variable is marked on its own field**, not summarised as a list
 *   of indices under a preview nobody could see.
 */

export type TemplatePickerProps = {
  fieldMetadataId?: string | null;
  templates: FeedTemplate[];
  t: Translate;
  onCancel: () => void;
  onSend: (templateId: string, parameters: ResolvedParameters) => Promise<boolean>;
  isSending: boolean;
};

const specOf = (template: FeedTemplate | null): VariableSpec | null => {
  const raw = template?.variableSpec;

  return raw === null || raw === undefined ? null : (raw as unknown as VariableSpec);
};

export const TemplatePicker = ({
  fieldMetadataId,
  templates,
  t,
  onCancel,
  onSend,
  isSending,
}: TemplatePickerProps) => {
  const theme = useTheme();
  const submitted = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [headerValues, setHeaderValues] = useState<string[]>([]);
  /** A media header's file, as an address in Twenty's own storage (D-59). */
  const [headerFile, setHeaderFile] = useState<SelectedFile | null>(null);
  /** Keyed by button index, because the indices are Meta's and need not be dense. */
  const [buttonValues, setButtonValues] = useState<Record<number, string>>({});
  /** Empty fields are marked only once a send has been attempted. */
  const [attempted, setAttempted] = useState(false);
  /** The preview is clamped by default; this opens it in full. See below. */
  const [previewOpen, setPreviewOpen] = useState(false);

  /**
   * One template is not a choice.
   *
   * The list opened on `—` even when there was exactly one thing to pick, so
   * the first act of every template send was a decision with one option — and
   * the panel opened showing nothing at all, which is the worst possible answer
   * to "why did my conversation disappear".
   *
   * **Derived, not written by an effect.** An effect that calls `setState` on a
   * prop it also depends on is one stale dependency away from a render loop,
   * and a render loop in a front component freezes the whole CRM tab. Reading
   * the default instead cannot loop: there is no write.
   */
  const effectiveId = selectedId ?? (templates.length === 1 ? templates[0]!.id : null);

  const selected = templates.find((template) => template.id === effectiveId) ?? null;
  const spec = specOf(selected);

  const hints = useMemo(() => bodyVariableHints(spec), [spec]);
  const headerHints = useMemo(() => headerVariableHints(spec), [spec]);
  const mediaHeader = useMemo(() => mediaHeaderOf(spec), [spec]);
  const buttonHints = useMemo(() => buttonVariableHints(spec), [spec]);
  const buttons = useMemo(() => buttonLabels(spec), [spec]);

  /**
   * The same address rule the send route applies. A media header pointing
   * outside Twenty's file store fails for the recipient rather than here, so it
   * is caught while the box is still on screen (D-58).
   */
  const headerFileValid = headerFile !== null;

  /**
   * Everything the validator counts, not just the body.
   *
   * The form used to build `{ body }` alone while `validateParameters` also
   * checked the header and the buttons — so a template with either could never
   * satisfy it, and Send stayed disabled however many boxes were filled.
   */
  const parameters: ResolvedParameters = useMemo(
    () => ({
      ...emptyParameters(),
      body: values,
      /**
       * A media header and a text header are mutually exclusive — a template
       * has one header — so this is a choice, not two spreads that could both
       * apply. Only a *valid* address is offered as the header: handing the
       * validator a half-typed URL would light Send up on a send that cannot
       * work (D-59).
       */
      ...(mediaHeader !== null
        ? {
            header: {
              kind: 'media' as const,
              mediaId: null,
              fileId: headerFile?.fileId ?? null,
              filePath: headerFile?.path ?? null,
              filename: headerFile?.filename,
            },
          }
        : headerHints.length === 0
          ? {}
          : { header: { kind: 'text' as const, values: headerValues } }),
      buttons: buttonHints.map((button) => ({
        index: button.index,
        subType: button.subType,
        value: buttonValues[button.index] ?? '',
      })),
    }),
    [
      values,
      headerValues,
      buttonValues,
      headerHints,
      buttonHints,
      mediaHeader,
      headerFile,
      headerFileValid,
    ],
  );

  const validation = useMemo(
    () => (spec === null ? null : validateParameters(spec, parameters)),
    [spec, parameters],
  );

  const preview = useMemo(
    () => (spec === null ? null : renderTemplate(spec, parameters)),
    [spec, parameters],
  );

  const ready = selected !== null && validation?.ok === true;

  const submit = async () => {
    setAttempted(true);

    if (!ready || isSending || submitted.current) return;
    submitted.current = true;

    try {
      await onSend(selected.id, parameters);
    } finally {
      submitted.current = false;
    }
  };

  const control: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: '32px',
    border: `1px solid ${theme.border.color.medium}`,
    borderRadius: theme.border.radius.sm,
    background: theme.background.secondary,
    color: theme.font.color.primary,
    fontFamily: theme.font.family,
    fontSize: theme.font.size.sm,
    padding: `0 ${theme.spacing[1]}`,
  };

  const action = (emphasis: 'loud' | 'quiet' | 'disabled'): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing[1],
    minHeight: '32px',
    border:
      emphasis === 'quiet'
        ? `1px solid ${theme.border.color.medium}`
        : '1px solid transparent',
    borderRadius: theme.border.radius.sm,
    background:
      emphasis === 'loud'
        ? theme.color.blue
        : emphasis === 'disabled'
          ? theme.background.transparent.light
          : 'transparent',
    color:
      emphasis === 'loud'
        ? theme.font.color.inverted
        : emphasis === 'disabled'
          ? theme.font.color.secondary
          : theme.font.color.secondary,
    cursor: emphasis === 'disabled' ? 'default' : 'pointer',
    fontFamily: theme.font.family,
    fontSize: theme.font.size.sm,
    padding: `0 ${theme.spacing[2]}`,
  });

  /**
   * One labelled input, shared by the header, body and button variables.
   *
   * A closure rather than a component so it keeps the picker's own `control`
   * style and `attempted` flag without threading either through props — there
   * is exactly one caller and three call sites.
   */
  const field = ({
    id,
    hint,
    value,
    badge,
    errorCode,
    onChange,
  }: {
    id: string;
    hint: { token: string; context: string | null; example: string | null };
    value: string;
    badge?: string;
    /**
     * The `builder.error.*` code to show instead of "required". A media header
     * has two ways to be wrong — empty, and pointing outside Twenty's file
     * store — and they need different sentences (D-59).
     */
    errorCode?: string | null;
    onChange: (value: string) => void;
  }) => {
    const missing =
      errorCode === undefined ? attempted && isBlank(value) : errorCode !== null;

    return (
      <div
        key={id}
        style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[0.5] }}
      >
        <label
          htmlFor={id}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: theme.spacing[1],
            fontSize: theme.font.size.xs,
            color: theme.font.color.secondary,
          }}
        >
          {badge === undefined ? null : (
            <span
              style={{
                flex: '0 0 auto',
                color: theme.font.color.secondary,
                background: theme.background.transparent.light,
                borderRadius: theme.border.radius.sm,
                padding: `0 ${theme.spacing[1]}`,
              }}
            >
              {badge}
            </span>
          )}
          {/*
            The words around the placeholder, which is what actually tells a rep
            what belongs here. The token stays beside it, small, as the
            unambiguous identity — two people discussing "the fourth variable"
            still need to see which one that is.
          */}
          <span style={{ flex: '1 1 auto', minWidth: 0 }}>
            {hint.context ?? hint.token}
          </span>
          <span style={{ color: theme.font.color.secondary, flex: '0 0 auto' }}>
            {hint.token}
          </span>
        </label>
        <input
          id={id}
          disabled={isSending}
          type="text"
          value={value}
          placeholder={hint.example ?? undefined}
          aria-invalid={missing ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
          style={{
            ...control,
            border: `1px solid ${
              missing ? theme.border.color.danger : theme.border.color.medium
            }`,
          }}
        />
        {missing ? (
          <span
            role="alert"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.spacing[1],
              fontSize: theme.font.size.xs,
              color: theme.font.color.danger,
            }}
          >
            <Glyph name="warning" />
            {t(`builder.error.${errorCode ?? 'REQUIRED'}`)}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <div
      className="wa-template-picker"
      style={{
        flex: '1 1 auto',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        // The panel is a column with one scrolling middle; the two ends stay put.
        overflow: 'hidden',
      }}
    >
      {/*
        The select is the panel's own control; the panel's *name* is on the frame
        above it (`PanelFrame`), so repeating "Choose a template" as a visible
        label would be the same words twice in adjacent rows.
      */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[1],
          flex: '0 0 auto',
          padding: `${theme.spacing[2]} ${theme.spacing[2]} ${theme.spacing[1]}`,
        }}
      >
        <select
          id="wa-template-select"
          disabled={isSending}
          aria-label={t('chat.chooseTemplate')}
          value={effectiveId ?? ''}
          onChange={(event) => {
            setSelectedId(event.target.value === '' ? null : event.target.value);
            // A different template means different variables; carrying the old
            // values over would fill {{2}} with something meant for {{1}}.
            setValues([]);
            setHeaderValues([]);
            setHeaderFile(null);
            setButtonValues({});
            setAttempted(false);
          }}
          style={{ ...control, flex: '1 1 auto', minWidth: 0 }}
        >
          <option value="">—</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name} ({template.language}) · {template.category}
            </option>
          ))}
        </select>
      </header>

      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: theme.spacing[2],
          padding: `0 ${theme.spacing[2]}`,
        }}
      >
        {templates.length === 0 ? (
          <div style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}>
            {t('chat.noTemplates')}
          </div>
        ) : null}

        {/*
          The preview first. It is what the rep is trying to produce, it changes
          as they type, and putting it under six inputs is what made it
          invisible — a template with six variables pushed it past the fold on
          every pane this component renders in.
        */}
        {preview === null ? null : (
          <div
            style={{
              border: `1px solid ${theme.border.color.light}`,
              borderRadius: theme.border.radius.md,
              background: theme.background.transparent.lighter,
              padding: theme.spacing[2],
              display: 'flex',
              flexDirection: 'column',
              gap: theme.spacing[1],
              /*
                Clamped, and deliberately **not** scrollable.

                A long template's preview is taller than the panel, so it has to
                be bounded or every input falls below the fold. The obvious
                bound — `overflow: auto` — was worse than the problem: the
                preview then swallowed the wheel, and a rep scrolling towards
                the fields just scrolled the preview instead, with no way past
                it. Clamping with `hidden` lets the wheel through to the panel,
                and the toggle below is how you read the rest.
              */
              flex: '0 0 auto',
              maxHeight: previewOpen ? undefined : '9rem',
              overflow: 'hidden',
            }}
          >
            <span
              style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}
            >
              {t('builder.preview')}
            </span>
            {preview.header === null ? null : (
              <div
                style={{
                  fontSize: theme.font.size.sm,
                  fontWeight: theme.font.weight.semiBold,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {preview.header}
              </div>
            )}
            <div
              style={{
                fontSize: theme.font.size.sm,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {preview.body}
            </div>
            {preview.footer === null ? null : (
              <div
                style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}
              >
                {preview.footer}
              </div>
            )}
            {buttons.length === 0 ? null : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.spacing[0.5],
                  marginTop: theme.spacing[0.5],
                }}
              >
                {buttons.map((label) => (
                  <span
                    key={label}
                    style={{
                      textAlign: 'center',
                      border: `1px solid ${theme.border.color.light}`,
                      borderRadius: theme.border.radius.sm,
                      padding: `${theme.spacing[0.5]} ${theme.spacing[1]}`,
                      fontSize: theme.font.size.xs,
                      color: theme.color.blue,
                    }}
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {preview === null ? null : (
          <button
            type="button"
            onClick={() => setPreviewOpen((current) => !current)}
            aria-expanded={previewOpen}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              alignSelf: 'flex-start',
              gap: theme.spacing[1],
              minHeight: '28px',
              border: 'none',
              background: 'transparent',
              color: theme.font.color.secondary,
              cursor: 'pointer',
              fontFamily: theme.font.family,
              fontSize: theme.font.size.xs,
              padding: 0,
            }}
          >
            <Glyph name={previewOpen ? 'chevronDown' : 'chevron'} />
            {t(previewOpen ? 'common.less' : 'common.more')}
          </button>
        )}

        {/*
          The header image, video or document (D-59).

          Templates like `convite_inicial` carry one, `validateParameters`
          counts it, and until now nothing on this screen collected it — so Send
          was permanently disabled and the footer read "Missing: 1" about a
          component with no field. The same address rule as the attachment
          panel, because it is the same read on the server.
        */}
        {mediaHeader === null ? null : <FileUpload
          key={effectiveId ?? 'none'} t={t} fieldMetadataId={fieldMetadataId}
          value={headerFile} onChange={setHeaderFile} disabled={isSending}
          requiredKind={mediaKindForHeaderFormat(mediaHeader.format) ?? 'document'}
        />}

        {headerHints.map((hint, index) =>
          field({
            id: `wa-template-header-${index}`,
            hint,
            badge: t('chat.templateHeader'),
            value: headerValues[index] ?? '',
            onChange: (next) =>
              setHeaderValues((current) => {
                const copy = [...current];

                copy[index] = next;

                return copy;
              }),
          }),
        )}

        {hints.map((hint, index) =>
          field({
            id: `wa-template-var-${index}`,
            hint,
            value: values[index] ?? '',
            onChange: (next) =>
              setValues((current) => {
                const copy = [...current];

                copy[index] = next;

                return copy;
              }),
          }),
        )}

        {/*
          A dynamic button. The label the customer taps is the heading, and the
          URL template sits under it so it is obvious that only its tail is
          being filled — a rep asked for "the button value" with no other
          context reasonably types the whole address.
        */}
        {buttonHints.map((button) =>
          field({
            id: `wa-template-button-${button.index}`,
            hint: {
              token: `#${button.index + 1}`,
              context: button.label ?? t('chat.templateButton'),
              example: button.url,
            },
            badge:
              button.subType === 'copy_code'
                ? t('chat.templateCopyCode')
                : t('chat.templateButtonUrl'),
            value: buttonValues[button.index] ?? '',
            onChange: (next) =>
              setButtonValues((current) => ({ ...current, [button.index]: next })),
          }),
        )}
      </div>

      {/*
        Pinned, because the two things a rep needs at every moment are "send
        this" and "give me my conversation back" — and both used to be below
        the fold of a six-variable form.
      */}
      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[2],
          flex: '0 0 auto',
          borderTop: `1px solid ${theme.border.color.light}`,
          padding: theme.spacing[2],
        }}
      >
        {selected === null || validation?.ok === true ? null : (
          <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
            {t('chat.missing')}: {validation?.missingKeys.length ?? 0}
          </span>
        )}
        <span style={{ flex: '1 1 auto' }} />
        <button type="button" disabled={isSending} onClick={onCancel} style={action('quiet')}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={isSending || !ready}
          aria-label={t('chat.send')}
          style={action(ready && !isSending ? 'loud' : 'disabled')}
        >
          <Glyph name="send" size="md" />
          {isSending ? t('chat.sending') : t('chat.send')}
        </button>
      </footer>
    </div>
  );
};
