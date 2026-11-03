import { useMemo, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import { projectInteractive } from '../../../domain/feed/content';
import {
  emptyButtonsDraft,
  emptyListDraft,
  moveItem,
  newInteractiveId,
  rowCount,
  toInteractive,
  type InteractiveDraft,
} from '../../../domain/interactive/draft';
import {
  INTERACTIVE_LIMITS,
  validateInteractive,
  type FieldError,
} from '../../../domain/interactive/validate';
import type { Translate } from '../../common/copy';
import { InteractiveContent } from '../renderers/rich';
import { IconButton, PanelFooter, TextField, errorFor } from './fields';

/**
 * The quick-reply and list builders (spec §"Interactive-message authoring").
 *
 * One component for both, because they are the same form with a different tail:
 * header, body and footer are identical, and only the action differs — one to
 * three reply buttons, or sections of rows behind a button label. Two
 * components would mean two implementations of the header/body/footer rules and
 * two chances to get the optional-field handling wrong.
 *
 * **Never a JSON editor.** The spec is explicit, and the reason is that the ids
 * are the part a rep must not have to think about: they are opaque, generated
 * once, and stable across every edit of the label. A JSON field invites editing
 * them, and an edited id silently breaks whatever automation matched the old
 * one.
 *
 * **Validated locally with the same module the route uses.** The button is
 * disabled while the draft is invalid, and the route re-validates and returns
 * field paths this form displays — so a local check that drifted from the
 * server's would show a green button for a message about to be refused.
 */

export type InteractiveBuilderProps = {
  kind: 'buttons' | 'list';
  t: Translate;
  isSending: boolean;
  /** Field-addressed errors from the route's own validator, if a send was refused. */
  serverErrors: FieldError[];
  onCancel: () => void;
  onSend: (interactive: Record<string, unknown>) => void;
};

export const InteractiveBuilder = ({
  kind,
  t,
  isSending,
  serverErrors,
  onCancel,
  onSend,
}: InteractiveBuilderProps) => {
  const theme = useTheme();
  const [draft, setDraft] = useState<InteractiveDraft>(() =>
    kind === 'buttons' ? emptyButtonsDraft() : emptyListDraft(),
  );
  /**
   * Local errors appear only after a send is attempted.
   *
   * Marking every empty box red before the rep has typed in it is a form that
   * greets you by telling you that you are wrong — and the disabled button
   * already says the draft is not ready.
   */
  const [attempted, setAttempted] = useState(false);

  const payload = useMemo(() => toInteractive(draft), [draft]);
  const validation = useMemo(() => validateInteractive(payload), [payload]);

  /**
   * The server's answer wins where both have something to say: it is the
   * authoritative check, and a local rule that disagreed with it would leave a
   * field marked valid under a message saying it was refused.
   */
  const errors = [
    ...serverErrors,
    ...(attempted && !validation.ok
      ? validation.errors.filter(
          (error) => !serverErrors.some((server) => server.field === error.field),
        )
      : []),
  ];

  const submit = () => {
    setAttempted(true);

    if (!validation.ok || isSending) return;

    onSend(payload);
  };

  const patch = (changes: Partial<InteractiveDraft>) =>
    setDraft((current) => ({ ...current, ...changes }) as InteractiveDraft);

  const rows = rowCount(draft);

  return (
    <div
      className="wa-thread-builder"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        padding: theme.spacing[2],
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
      }}
    >
      <p
        style={{ margin: 0, fontSize: theme.font.size.xs, color: theme.font.color.secondary }}
      >
        {t('builder.idsAreAutomatic')}
      </p>

      {serverErrors.length === 0 ? null : (
        <div
          role="alert"
          style={{
            fontSize: theme.font.size.xs,
            color: theme.font.color.danger,
            background: theme.background.transparent.danger,
            borderRadius: theme.border.radius.sm,
            padding: theme.spacing[1],
          }}
        >
          {t('builder.invalid')}
        </div>
      )}

      <div
        className="wa-thread-builder-panes"
        style={{ display: 'flex', gap: theme.spacing[2], flexWrap: 'wrap' }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing[2],
            flex: '2 1 260px',
            minWidth: 0,
          }}
        >
          <TextField
            id="wa-builder-header"
            label={t('builder.header')}
            value={draft.header}
            onChange={(header) => patch({ header })}
            maxLength={INTERACTIVE_LIMITS.HEADER}
            error={errorFor(errors, 'header.text')}
            t={t}
          />

          <TextField
            id="wa-builder-body"
            label={t('builder.body')}
            value={draft.body}
            onChange={(body) => patch({ body })}
            maxLength={INTERACTIVE_LIMITS.BODY}
            rows={3}
            error={errorFor(errors, 'body.text')}
            counter={`${draft.body.trim().length} / ${INTERACTIVE_LIMITS.BODY}`}
            t={t}
          />

          <TextField
            id="wa-builder-footer"
            label={t('builder.footer')}
            value={draft.footer}
            onChange={(footer) => patch({ footer })}
            maxLength={INTERACTIVE_LIMITS.FOOTER}
            error={errorFor(errors, 'footer.text')}
            t={t}
          />

          {draft.kind === 'buttons' ? (
            <ButtonsEditor draft={draft} errors={errors} t={t} onChange={setDraft} />
          ) : (
            <ListEditor draft={draft} errors={errors} rows={rows} t={t} onChange={setDraft} />
          )}
        </div>

        {/*
          The contact's view, rendered by the *same* component the transcript
          uses. A hand-drawn mock-up would be a second implementation of the
          message layout, and the whole value of a preview is that it is not.
        */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing[1],
            flex: '1 1 220px',
            minWidth: 0,
          }}
        >
          <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
            {t('builder.preview')}
          </span>
          <div
            style={{
              border: `1px solid ${theme.border.color.light}`,
              borderRadius: theme.border.radius.md,
              background: theme.background.secondary,
              padding: theme.spacing[2],
              minWidth: 0,
            }}
          >
            <InteractiveContent interactive={projectInteractive(payload)} t={t} />
          </div>
        </div>
      </div>

      <PanelFooter
        submitLabel={t(kind === 'buttons' ? 'builder.sendButtons' : 'builder.sendList')}
        onCancel={onCancel}
        onSubmit={submit}
        disabled={isSending || (attempted && !validation.ok)}
        t={t}
      />
    </div>
  );
};

const SectionFrame = ({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) => {
  const theme = useTheme();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[1],
        border: `1px solid ${theme.border.color.light}`,
        borderRadius: theme.border.radius.sm,
        padding: theme.spacing[1],
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[1] }}>
        <span
          style={{
            flex: '1 1 auto',
            fontSize: theme.font.size.xs,
            fontWeight: theme.font.weight.medium,
            color: theme.font.color.secondary,
          }}
        >
          {title}
        </span>
        {actions}
      </div>
      {children}
    </div>
  );
};

const ButtonsEditor = ({
  draft,
  errors,
  t,
  onChange,
}: {
  draft: Extract<InteractiveDraft, { kind: 'buttons' }>;
  errors: FieldError[];
  t: Translate;
  onChange: (draft: InteractiveDraft) => void;
}) => {
  const theme = useTheme();

  const setButtons = (buttons: typeof draft.buttons) => onChange({ ...draft, buttons });

  return (
    <SectionFrame
      title={`${t('builder.buttons')} — ${draft.buttons.length} / ${INTERACTIVE_LIMITS.MAX_BUTTONS}`}
      actions={
        <IconButton
          icon="newCampaign"
          label={t('builder.addButton')}
          disabled={draft.buttons.length >= INTERACTIVE_LIMITS.MAX_BUTTONS}
          onClick={() =>
            setButtons([...draft.buttons, { id: newInteractiveId('btn'), title: '' }])
          }
        />
      }
    >
      {draft.buttons.map((button, index) => (
        <div
          key={button.id}
          style={{ display: 'flex', alignItems: 'flex-end', gap: theme.spacing[1] }}
        >
          <span style={{ flex: '1 1 auto', minWidth: 0 }}>
            <TextField
              id={`wa-builder-button-${button.id}`}
              label={t('builder.buttonTitle', { index: index + 1 })}
              value={button.title}
              maxLength={INTERACTIVE_LIMITS.BUTTON_TITLE}
              onChange={(title) =>
                setButtons(
                  draft.buttons.map((entry, position) =>
                    position === index ? { ...entry, title } : entry,
                  ),
                )
              }
              error={
                errorFor(errors, `action.buttons.${index}.reply.title`) ??
                errorFor(errors, `action.buttons.${index}.reply.id`)
              }
              t={t}
            />
          </span>
          <IconButton
            icon="moveUp"
            label={t('builder.moveUp')}
            disabled={index === 0}
            onClick={() => setButtons(moveItem(draft.buttons, index, index - 1))}
          />
          <IconButton
            icon="moveDown"
            label={t('builder.moveDown')}
            disabled={index === draft.buttons.length - 1}
            onClick={() => setButtons(moveItem(draft.buttons, index, index + 1))}
          />
          <IconButton
            icon="remove"
            tone="danger"
            label={t('builder.removeButton', { index: index + 1 })}
            disabled={draft.buttons.length <= 1}
            onClick={() =>
              setButtons(draft.buttons.filter((_, position) => position !== index))
            }
          />
        </div>
      ))}
    </SectionFrame>
  );
};

const ListEditor = ({
  draft,
  errors,
  rows,
  t,
  onChange,
}: {
  draft: Extract<InteractiveDraft, { kind: 'list' }>;
  errors: FieldError[];
  rows: number;
  t: Translate;
  onChange: (draft: InteractiveDraft) => void;
}) => {
  const theme = useTheme();

  const setSections = (sections: typeof draft.sections) => onChange({ ...draft, sections });

  const patchSection = (index: number, changes: Partial<(typeof draft.sections)[number]>) =>
    setSections(
      draft.sections.map((section, position) =>
        position === index ? { ...section, ...changes } : section,
      ),
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[2] }}>
      <TextField
        id="wa-builder-list-button"
        label={t('builder.buttonLabel')}
        value={draft.buttonText}
        maxLength={INTERACTIVE_LIMITS.LIST_BUTTON}
        onChange={(buttonText) => onChange({ ...draft, buttonText })}
        error={errorFor(errors, 'action.button')}
        t={t}
      />

      {draft.sections.map((section, sectionIndex) => (
        <SectionFrame
          key={`section-${sectionIndex}`}
          title={t('builder.section', { index: sectionIndex + 1 })}
          actions={
            <>
              <IconButton
                icon="moveUp"
                label={t('builder.moveUp')}
                disabled={sectionIndex === 0}
                onClick={() => setSections(moveItem(draft.sections, sectionIndex, sectionIndex - 1))}
              />
              <IconButton
                icon="moveDown"
                label={t('builder.moveDown')}
                disabled={sectionIndex === draft.sections.length - 1}
                onClick={() => setSections(moveItem(draft.sections, sectionIndex, sectionIndex + 1))}
              />
              <IconButton
                icon="remove"
                tone="danger"
                label={t('builder.removeSection', { index: sectionIndex + 1 })}
                disabled={draft.sections.length <= 1}
                onClick={() =>
                  setSections(draft.sections.filter((_, position) => position !== sectionIndex))
                }
              />
            </>
          }
        >
          <TextField
            id={`wa-builder-section-${sectionIndex}`}
            label={t('builder.sectionTitle', { index: sectionIndex + 1 })}
            value={section.title}
            maxLength={INTERACTIVE_LIMITS.SECTION_TITLE}
            onChange={(title) => patchSection(sectionIndex, { title })}
            error={errorFor(errors, `action.sections.${sectionIndex}.title`)}
            t={t}
          />

          {section.rows.map((row, rowIndex) => (
            <div
              key={row.id}
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: theme.spacing[1],
                flexWrap: 'wrap',
              }}
            >
              <span style={{ flex: '1 1 140px', minWidth: 0 }}>
                <TextField
                  id={`wa-builder-row-${row.id}`}
                  label={t('builder.rowTitle', { index: rowIndex + 1 })}
                  value={row.title}
                  maxLength={INTERACTIVE_LIMITS.ROW_TITLE}
                  onChange={(title) =>
                    patchSection(sectionIndex, {
                      rows: section.rows.map((entry, position) =>
                        position === rowIndex ? { ...entry, title } : entry,
                      ),
                    })
                  }
                  error={
                    errorFor(errors, `action.sections.${sectionIndex}.rows.${rowIndex}.title`) ??
                    errorFor(errors, `action.sections.${sectionIndex}.rows.${rowIndex}.id`)
                  }
                  t={t}
                />
              </span>
              <span style={{ flex: '2 1 180px', minWidth: 0 }}>
                <TextField
                  id={`wa-builder-row-description-${row.id}`}
                  label={t('builder.rowDescription', { index: rowIndex + 1 })}
                  value={row.description}
                  maxLength={INTERACTIVE_LIMITS.ROW_DESCRIPTION}
                  onChange={(description) =>
                    patchSection(sectionIndex, {
                      rows: section.rows.map((entry, position) =>
                        position === rowIndex ? { ...entry, description } : entry,
                      ),
                    })
                  }
                  error={errorFor(
                    errors,
                    `action.sections.${sectionIndex}.rows.${rowIndex}.description`,
                  )}
                  t={t}
                />
              </span>
              <IconButton
                icon="moveUp"
                label={t('builder.moveUp')}
                disabled={rowIndex === 0}
                onClick={() =>
                  patchSection(sectionIndex, {
                    rows: moveItem(section.rows, rowIndex, rowIndex - 1),
                  })
                }
              />
              <IconButton
                icon="moveDown"
                label={t('builder.moveDown')}
                disabled={rowIndex === section.rows.length - 1}
                onClick={() =>
                  patchSection(sectionIndex, {
                    rows: moveItem(section.rows, rowIndex, rowIndex + 1),
                  })
                }
              />
              <IconButton
                icon="remove"
                tone="danger"
                label={t('builder.removeRow', { index: rowIndex + 1 })}
                disabled={section.rows.length <= 1}
                onClick={() =>
                  patchSection(sectionIndex, {
                    rows: section.rows.filter((_, position) => position !== rowIndex),
                  })
                }
              />
            </div>
          ))}

          <IconButton
            icon="newCampaign"
            label={t('builder.addRow')}
            disabled={rows >= INTERACTIVE_LIMITS.MAX_ROWS}
            onClick={() =>
              patchSection(sectionIndex, {
                rows: [
                  ...section.rows,
                  { id: newInteractiveId('row'), title: '', description: '' },
                ],
              })
            }
          />
        </SectionFrame>
      ))}

      {/*
        The live count against Meta's cap. Without it the only feedback on the
        row limit is a refusal after the message is written, and the spec asks
        for the number to be visible while it is being built.
      */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[2],
          fontSize: theme.font.size.xs,
          color:
            rows > INTERACTIVE_LIMITS.MAX_ROWS
              ? theme.font.color.danger
              : theme.font.color.secondary,
        }}
      >
        <span style={{ flex: '1 1 auto' }}>
          {t('builder.rowsUsed', { used: rows, limit: INTERACTIVE_LIMITS.MAX_ROWS })}
        </span>
        <IconButton
          icon="newCampaign"
          label={t('builder.addSection')}
          disabled={draft.sections.length >= INTERACTIVE_LIMITS.MAX_SECTIONS}
          onClick={() =>
            setSections([
              ...draft.sections,
              {
                title: '',
                rows: [{ id: newInteractiveId('row'), title: '', description: '' }],
              },
            ])
          }
        />
      </div>
    </div>
  );
};
