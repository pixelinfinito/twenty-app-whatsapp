import { useId, useRef, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { ContactCardProjection } from '../../domain/feed/content';
import type { PersonProjection } from '../../domain/feed/projection';
import type { QuoteProjection } from '../../domain/feed/quote';
import type { FieldError } from '../../domain/interactive/validate';
import type { ResolvedParameters } from '../../domain/template-render';
import type { Translate } from '../common/copy';
import { Glyph, type IconName } from '../common/icons';
import type { ThreadCapabilities } from '../../domain/feed/capabilities';
import type { FeedPolicy, FeedTemplate } from '../common/use-feed';
import { InteractiveBuilder } from './builders/InteractiveBuilder';
import {
  AttachmentPanel,
  ContactPanel,
  LocationPanel,
  type RecentAttachment,
} from './builders/SendPanels';
import { VoicePanel } from './builders/VoicePanel';
import { ComposerAction } from './ComposerAction';
import { QuoteStrip } from './QuoteStrip';
import { TemplatePicker } from './TemplatePicker';

/**
 * Where a rep works (specs/08 §3.3, FR-OUT-1, FR-OUT-2, spec §"Composer
 * redesign").
 *
 * Every state below is driven by the server's `policy` and `capabilities`. The
 * composer does not know what the 24-hour rule is and must not: the rule lives
 * in one pure module that the send route re-runs immediately before the Meta
 * call (AR-17), so a component that re-derived it would eventually enable an
 * action for a send that is about to be refused.
 *
 * `WINDOW_CLOSED` is still the interesting denial. It does not merely disable
 * the box — it *replaces* the primary action with **Escolher modelo**, because
 * a closed window is not a dead end, it is an instruction (FR-OUT-5). What is
 * new is that the ＋ menu obeys the same rule per entry: a closed window greys
 * every session action and leaves the template path lit, rather than offering
 * eight things that would all be refused.
 *
 * **One mode at a time, as a discriminated state.** The predecessor had two
 * booleans; eight would be 256 representable states, most of them nonsense —
 * an attachment panel open *over* the template picker with a recording running.
 * A single `mode` makes those unrepresentable.
 *
 * Sandbox mechanics, unchanged and still binding: the textarea is controlled
 * and never autofocused (`.focus()` throws), Enter sends and Shift+Enter breaks
 * the line, panels render inline because portals render nothing, and a refusal
 * renders inline rather than as a toast — a toast that has faded cannot be
 * re-read.
 */

export type ComposerMode =
  | { kind: 'text' }
  | { kind: 'template' }
  | { kind: 'attachment'; initial: 'image' | 'document' }
  | { kind: 'voice' }
  | { kind: 'location' }
  | { kind: 'contact' }
  | { kind: 'interactive-buttons' }
  | { kind: 'interactive-list' };

export type ComposerProps = {
  policy: FeedPolicy | undefined;
  capabilities: ThreadCapabilities | undefined;
  templates: FeedTemplate[];
  canSend: boolean;
  t: Translate;
  isSending: boolean;
  /** A `DENIAL` code from a 409, kept on screen until the rep acts. */
  refusal: string | null;
  /** Field-addressed errors from the route, routed to the open builder. */
  fieldErrors: FieldError[];
  /** The message being replied to, shown as a strip above the box. */
  replyTarget: QuoteProjection | null;
  person: PersonProjection | null;
  /** Files already in this conversation, for the attachment panel's reuse list. */
  recentFiles?: RecentAttachment[];
  fieldMetadataId?: string | null;
  onSendText: (body: string) => Promise<boolean>;
  onSendTemplate: (templateId: string, parameters: ResolvedParameters) => Promise<boolean>;
  onSendMedia: (input: {
    mediaKind: 'image' | 'video' | 'audio' | 'document';
    fileId?: string;
    fileUrl?: string;
    filePath?: string;
    filename: string | null;
    caption: string | null;
    voice?: boolean;
  }) => Promise<boolean>;
  onSendLocation: (input: {
    latitude: number;
    longitude: number;
    name: string | null;
    address: string | null;
  }) => Promise<boolean>;
  onSendContact: (contact: ContactCardProjection) => Promise<boolean>;
  /**
   * Resolves to whether the route accepted it. The builder stays open on a
   * refusal, because that is the only surface its field-addressed errors have.
   */
  onSendInteractive: (interactive: Record<string, unknown>) => Promise<boolean>;
  onCancelReply: () => void;
  onDismissRefusal: () => void;
};

export const MAX_TEXT_LENGTH = 4096;

/**
 * How much of the conversation a composer panel takes.
 *
 * A template with six variables rendered a form taller than the pane and the
 * transcript went with it — a rep filling one in could not see the message they
 * were answering, or check the name they were about to type.
 *
 * **A definite height, not a maximum, and not a percentage.** Both of the
 * obvious alternatives failed here, and the reasons are worth keeping:
 *
 * - A *percentage* resolves against a containing block whose own height comes
 *   from this element — circular, and every engine breaks the tie differently.
 * - A *maximum* over a scrolling child is no constraint at all: the child sets
 *   `min-height: 0` so it can scroll, which also means it contributes nothing
 *   to the intrinsic height, so the panel sized itself to its header and footer
 *   and squeezed the fields into a one-row strip. Giving the child a minimum
 *   instead just moved the fight — the minimum won and the panel overflowed,
 *   taking Send and Cancel past the bottom edge.
 *
 * One definite height ends the argument: the panel is exactly this tall, its
 * middle scrolls, and the transcript takes what is left.
 */
const PANEL_HEIGHT = '18rem';

/**
 * The chrome every composer panel wears: a title, a collapse toggle and a close.
 *
 * The toggle exists because a cap is not always enough. Reading four messages
 * back to find an address, then typing it into a field, is a real thing reps do,
 * and a 62 % panel leaves too little transcript for it. Collapsing hides the
 * panel's body **without unmounting it**, so a half-filled template survives
 * the trip and is still there on the way back — which is the whole point, and
 * the reason this is a wrapper rather than a flag inside each panel.
 */
const PanelFrame = ({
  title,
  icon,
  collapsed,
  onToggle,
  onClose,
  t,
  children,
}: {
  title: string;
  icon: IconName;
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
  t: Translate;
  children: React.ReactNode;
}) => {
  const theme = useTheme();

  const square: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    minWidth: '32px',
    minHeight: '32px',
    border: 'none',
    borderRadius: theme.border.radius.sm,
    background: 'transparent',
    color: theme.font.color.secondary,
    cursor: 'pointer',
    padding: 0,
  };

  return (
    <div
      className="wa-composer-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        ...(collapsed ? {} : { height: PANEL_HEIGHT }),
        overflow: 'hidden',
        borderTop: `1px solid ${theme.border.color.light}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[1],
          flex: '0 0 auto',
          padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
          background: theme.background.transparent.lighter,
        }}
      >
        <Glyph name={icon} />
        <span
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            fontSize: theme.font.size.xs,
            fontWeight: theme.font.weight.medium,
            color: theme.font.color.secondary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'chat.expandPanel' : 'chat.collapsePanel')}
          title={t(collapsed ? 'chat.expandPanel' : 'chat.collapsePanel')}
          style={square}
        >
          <Glyph name={collapsed ? 'chevron' : 'chevronDown'} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.cancel')}
          title={t('common.cancel')}
          style={square}
        >
          <Glyph name="dismiss" />
        </button>
      </div>

      {/*
        `display: none`, not a conditional render. Unmounting would throw away
        the draft the rep is halfway through, which is the opposite of what a
        collapse is for.
      */}
      <div
        style={{
          display: collapsed ? 'none' : 'flex',
          flexDirection: 'column',
          minHeight: 0,
          flex: '1 1 auto',
        }}
      >
        {children}
      </div>
    </div>
  );
};

/**
 * The emoji the ☺ button offers, appended to the end of the draft.
 *
 * Appended, not inserted at the caret, and that is a deliberate limitation
 * rather than an oversight: Twenty does not forward `onSelect`, and calling
 * `setSelectionRange()` or `.focus()` on a ref throws — so there is no way to
 * know where the caret is, and a picker that guessed would move a rep's text
 * at random. The spec is explicit that caret-aware insertion waits for a tested
 * event-based strategy.
 */
const DRAFT_EMOJI = [
  '🙂', '😀', '😅', '😊', '😍', '🤔', '👍', '👏',
  '🙏', '🎉', '❤️', '🔥', '✅', '❌', '⚠️', '📍',
] as const;


type SheetEntry = {
  key: string;
  icon: IconName;
  label: string;
  mode: ComposerMode;
  /** The capability that governs it, or null for the always-available ones. */
  capability: keyof ThreadCapabilities;
};

const SHEET: SheetEntry[] = [
  {
    key: 'photo',
    icon: 'photo',
    label: 'chat.attachPhoto',
    mode: { kind: 'attachment', initial: 'image' },
    capability: 'media',
  },
  {
    key: 'document',
    icon: 'document',
    label: 'chat.attachDocument',
    mode: { kind: 'attachment', initial: 'document' },
    capability: 'media',
  },
  {
    key: 'voice',
    icon: 'voice',
    label: 'chat.attachVoice',
    mode: { kind: 'voice' },
    capability: 'media',
  },
  {
    key: 'location',
    icon: 'location',
    label: 'chat.attachLocation',
    mode: { kind: 'location' },
    capability: 'location',
  },
  {
    key: 'contact',
    icon: 'contactCard',
    label: 'chat.attachContact',
    mode: { kind: 'contact' },
    capability: 'contacts',
  },
  {
    key: 'quickReplies',
    icon: 'quickReplies',
    label: 'chat.attachQuickReplies',
    mode: { kind: 'interactive-buttons' },
    capability: 'interactive',
  },
  {
    key: 'list',
    icon: 'listMessage',
    label: 'chat.attachList',
    mode: { kind: 'interactive-list' },
    capability: 'interactive',
  },
  {
    key: 'template',
    icon: 'template',
    label: 'chat.attachTemplate',
    mode: { kind: 'template' },
    capability: 'template',
  },
];

export const Composer = ({
  policy,
  capabilities,
  templates,
  canSend,
  t,
  isSending,
  refusal,
  fieldErrors,
  replyTarget,
  person,
  recentFiles = [],
  fieldMetadataId,
  onSendText,
  onSendTemplate,
  onSendMedia,
  onSendLocation,
  onSendContact,
  onSendInteractive,
  onCancelReply,
  onDismissRefusal,
}: ComposerProps) => {
  const theme = useTheme();
  const instanceId = useId();
  const hintId = `wa-compose-hint-${instanceId}`;
  const panelGeneration = useRef(0);
  const panelTicket = panelGeneration.current;
  const [draft, setDraft] = useState('');
  const draftValue = useRef('');
  draftValue.current = draft;
  const submitting = useRef(false);
  const [mode, setMode] = useState<ComposerMode>({ kind: 'text' });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  /**
   * Reset whenever the mode changes, so a panel never opens already collapsed —
   * which would look exactly like the ＋ menu having done nothing.
   */
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  const allowed = policy?.allowed === true;
  const reason = policy?.allowed === false ? policy.reason : null;
  const windowClosed = reason === 'WINDOW_CLOSED';

  /**
   * A template is still sendable when the window is closed — that exemption is
   * what makes FR-OUT-5 true. It is not sendable when the contact opted out,
   * the thread is blocked or the number is down, so those denials hide the
   * button rather than swapping it in.
   */
  const templateAvailable =
    capabilities?.template.allowed ?? (canSend && (allowed || windowClosed));

  const submit = async () => {
    const body = draft.trim();
    if (!body || !allowed || !canSend || isSending || submitting.current) return;
    submitting.current = true;
    const sentDraft = draft;
    try {
      if (await onSendText(body)) {
        // Keep anything typed while the request was in flight.
        if (draftValue.current === sentDraft) setDraft('');
      }
    } finally {
      submitting.current = false;
    }
  };

  const open = (next: ComposerMode) => {
    panelGeneration.current += 1;
    setMode(next);
    setSheetOpen(false);
    setPanelCollapsed(false);
  };

  const close = () => {
    panelGeneration.current += 1;
    setMode({ kind: 'text' });
    setSheetOpen(false);
    setPanelCollapsed(false);
  };

  /** The thread settles the consumed reply; the panel returns to the text box. */
  const afterSend = () => {
    close();
  };

  const disabledReason = !canSend
    ? t('chat.noPermission')
    : reason === null
      ? null
      : t(`policy.${reason}`);

  const isAvailable = (entry: SheetEntry): boolean =>
    capabilities === undefined
      ? canSend && (allowed || entry.capability === 'template')
      : capabilities[entry.capability].allowed;

  /**
   * What the panel's own header says it is.
   *
   * Named here rather than inside each panel because the frame is shared, and
   * because a collapsed panel is *only* this line — "Approved template" has to
   * be enough to know what is folded away underneath.
   */
  const [panelIcon, panelTitle]: [IconName, string] = (() => {
    switch (mode.kind) {
      case 'template':
        return ['template', t('chat.attachTemplate')];
      case 'attachment':
        return ['attachment', t('chat.attach')];
      case 'voice':
        return ['voice', t('chat.attachVoice')];
      case 'location':
        return ['location', t('chat.attachLocation')];
      case 'contact':
        return ['contactCard', t('chat.attachContact')];
      case 'interactive-buttons':
        return ['quickReplies', t('chat.attachQuickReplies')];
      case 'interactive-list':
        return ['listMessage', t('chat.attachList')];
      default:
        return ['send', t('chat.send')];
    }
  })();

  const panel = ((): React.ReactNode => {
    switch (mode.kind) {
      case 'template':
        return (
          <TemplatePicker
            fieldMetadataId={fieldMetadataId}
            templates={templates}
            t={t}
            isSending={isSending}
            onCancel={close}
            onSend={async (templateId, parameters) => {
              const accepted = await onSendTemplate(templateId, parameters);
              if (accepted && panelGeneration.current === panelTicket) afterSend();
              return accepted;
            }}
          />
        );

      case 'attachment':
        return (
          <AttachmentPanel
            t={t}
            isSending={isSending}
            initialKind={mode.initial}
            recentFiles={recentFiles}
            fieldMetadataId={fieldMetadataId}
            onCancel={close}
            onSend={async (input) => {
              const accepted = await onSendMedia({
                mediaKind: input.mediaKind,
                fileId: input.fileId,
                ...(input.fileUrl === undefined ? {} : { fileUrl: input.fileUrl }),
                ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
                filename: input.filename,
                caption: input.caption,
              });
              if (accepted && panelGeneration.current === panelTicket) afterSend();
              return accepted;
            }}
          />
        );

      case 'voice':
        return (
          <VoicePanel
            fieldMetadataId={fieldMetadataId}
            t={t}
            isSending={isSending}
            onSend={async (input) => {
              const accepted = await onSendMedia({
                mediaKind: 'audio',
                fileId: input.fileId,
                ...(input.fileUrl.length === 0 ? {} : { fileUrl: input.fileUrl }),
                ...(input.filePath.length === 0 ? {} : { filePath: input.filePath }),
                filename: input.filename,
                caption: null,
                voice: true,
              });
              if (accepted && panelGeneration.current === panelTicket) afterSend();
              return accepted;
            }}
          />
        );

      case 'location':
        return (
          <LocationPanel
            t={t}
            isSending={isSending}
            onCancel={close}
            onSend={async (location) => {
              const accepted = await onSendLocation(location);
              if (accepted && panelGeneration.current === panelTicket) afterSend();
              return accepted;
            }}
          />
        );

      case 'contact':
        return (
          <ContactPanel
            t={t}
            isSending={isSending}
            person={person}
            onCancel={close}
            onSend={async (contact) => {
              const accepted = await onSendContact(contact);
              if (accepted && panelGeneration.current === panelTicket) afterSend();
              return accepted;
            }}
          />
        );

      case 'interactive-buttons':
      case 'interactive-list':
        return (
          <InteractiveBuilder
            kind={mode.kind === 'interactive-buttons' ? 'buttons' : 'list'}
            t={t}
            isSending={isSending}
            serverErrors={fieldErrors}
            onCancel={close}
            onSend={(interactive) => {
              void onSendInteractive(interactive).then((accepted) => {
                if (accepted && panelGeneration.current === panelTicket) afterSend();
              });
            }}
          />
        );

      default:
        return null;
    }
  })();

  return (
    <div
      className="wa-composer"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        if (sheetOpen || emojiOpen) {
          event.preventDefault();
          event.stopPropagation();
          setSheetOpen(false);
          setEmojiOpen(false);
        }
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        /*
          Fixed, never squeezed. The transcript above is the elastic one
          (`flex: 1 1 auto`, `min-height: 0`) and gives up whatever the composer
          needs; the collapse toggle is how a rep gets it back.
        */
        flex: '0 0 auto',
        minHeight: 0,
        borderTop: `1px solid ${theme.border.color.light}`,
        background: theme.background.primary,
      }}
    >
      {(policy?.warnings ?? []).length === 0 ? null : (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: theme.spacing[2],
            padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
            fontSize: theme.font.size.xs,
            color: theme.font.color.secondary,
            background: theme.background.transparent.light,
          }}
        >
          {(policy?.warnings ?? []).map((warning) => (
            <span
              key={warning}
              style={{ display: 'inline-flex', alignItems: 'center', gap: theme.spacing[1] }}
            >
              <Glyph name="warning" />
              {t(`warning.${warning}`)}
            </span>
          ))}
        </div>
      )}

      {refusal === null ? null : (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing[2],
            padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
            fontSize: theme.font.size.sm,
            color: theme.font.color.danger,
            background: theme.background.transparent.danger,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.spacing[1] }}>
            <Glyph name="warning" />
            {t(`policy.${refusal}`)}
          </span>
          <span style={{ flex: '1 1 auto' }} />
          <button
            type="button"
            onClick={onDismissRefusal}
            aria-label={t('common.dismiss')}
            title={t('common.dismiss')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: '32px',
              minHeight: '32px',
              border: 'none',
              borderRadius: theme.border.radius.sm,
              background: 'transparent',
              color: theme.font.color.danger,
              cursor: 'pointer',
            }}
          >
            <Glyph name="dismiss" />
          </button>
        </div>
      )}

      {/*
        The reply strip stays above whichever panel is open: a rep who chose
        Reply and then opened the location panel is still replying, and the
        `contextWamid` travels with the location send.
      */}
      {replyTarget === null ? null : (
        <div style={{ padding: `${theme.spacing[1]} ${theme.spacing[2]} 0` }}>
          <QuoteStrip quote={replyTarget} t={t} onDismiss={onCancelReply} />
        </div>
      )}

      {panel === null ? null : (
        <PanelFrame
          title={panelTitle}
          icon={panelIcon}
          collapsed={panelCollapsed}
          onToggle={() => setPanelCollapsed((current) => !current)}
          onClose={close}
          t={t}
        >
          {panel}
        </PanelFrame>
      )}

      {panel !== null ? null : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing[1],
            padding: theme.spacing[2],
            // The containing block for the ＋ sheet and the emoji panel, both of
            // which are absolutely positioned because portals render nothing.
            position: 'relative',
          }}
        >
          {disabledReason === null ? null : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: theme.spacing[1],
                fontSize: theme.font.size.xs,
                color: theme.font.color.secondary,
              }}
            >
              <Glyph name={windowClosed ? 'windowClosed' : 'warning'} />
              {disabledReason}
            </div>
          )}

          {sheetOpen ? (
            <div
              className="wa-composer-sheet"
              role="group"
              aria-label={t('chat.attachTitle')}
              style={{
                position: 'absolute',
                bottom: '100%',
                left: theme.spacing[2],
                right: theme.spacing[2],
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: theme.spacing[1],
                border: `1px solid ${theme.border.color.medium}`,
                borderRadius: theme.border.radius.md,
                background: theme.background.primary,
                boxShadow: theme.boxShadow.strong,
                padding: theme.spacing[1],
                zIndex: 2,
              }}
            >
              {SHEET.map((entry) => {
                const available = isAvailable(entry);

                return (
                  <button
                    key={entry.key}
                    type="button"
                    disabled={!available}
                    title={available ? undefined : t('chat.unavailableHere')}
                    onClick={() => open(entry.mode)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: theme.spacing[1],
                      minHeight: '32px',
                      border: 'none',
                      borderRadius: theme.border.radius.sm,
                      background: 'transparent',
                      color: available
                        ? theme.font.color.secondary
                        : theme.font.color.secondary,
                      cursor: available ? 'pointer' : 'default',
                      fontFamily: theme.font.family,
                      fontSize: theme.font.size.sm,
                      padding: `0 ${theme.spacing[1]}`,
                      textAlign: 'left',
                    }}
                  >
                    <Glyph name={entry.icon} size="md" />
                    {t(entry.label)}
                  </button>
                );
              })}
            </div>
          ) : null}

          {emojiOpen ? (
            <div
              className="wa-composer-emoji"
              style={{
                position: 'absolute',
                bottom: '100%',
                left: theme.spacing[2],
                display: 'grid',
                gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
                gap: theme.spacing[0.5],
                border: `1px solid ${theme.border.color.medium}`,
                borderRadius: theme.border.radius.md,
                background: theme.background.primary,
                boxShadow: theme.boxShadow.strong,
                padding: theme.spacing[1],
                zIndex: 2,
              }}
            >
              {DRAFT_EMOJI.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setDraft((current) => `${current}${emoji}`)}
                  aria-label={emoji}
                  title={emoji}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: '32px',
                    minHeight: '32px',
                    border: 'none',
                    borderRadius: theme.border.radius.sm,
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: theme.font.size.md,
                    lineHeight: 1,
                    padding: 0,
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          ) : null}

          <div className="wa-composer-controls" data-disabled={!allowed || !canSend}>
            <textarea
              value={draft}
              disabled={!allowed || !canSend}
              className="wa-composer-input"
              maxLength={MAX_TEXT_LENGTH}
              aria-describedby={hintId}
              rows={3}
              placeholder={t('chat.placeholder')}
              aria-label={t('chat.placeholder')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="wa-composer-toolbar">
              <div className="wa-composer-tools">
                <ComposerAction
                  icon="newCampaign"
                  label={t('chat.attach')}
                  expanded={sheetOpen}
                  disabled={!canSend || isSending}
                  onClick={() => {
                    setSheetOpen((current) => !current);
                    setEmojiOpen(false);
                  }}
                />
                <ComposerAction
                  icon="react"
                  label={t('chat.emoji')}
                  expanded={emojiOpen}
                  disabled={!allowed || !canSend}
                  onClick={() => {
                    setEmojiOpen((current) => !current);
                    setSheetOpen(false);
                  }}
                />
                {templateAvailable ? (
                  <ComposerAction
                    icon="template"
                    label={t('chat.chooseTemplate')}
                    primary={!allowed}
                    disabled={!canSend || isSending}
                    onClick={() => open({ kind: 'template' })}
                  />
                ) : null}
              </div>
              <span id={hintId} className="wa-composer-hint">{t('chat.composeHint')}</span>
              <div className="wa-composer-actions">
                {draft.length >= MAX_TEXT_LENGTH - 256 ? (
                  <span className="wa-composer-count" aria-live="polite">{draft.length}/{MAX_TEXT_LENGTH}</span>
                ) : null}
                {allowed && canSend ? (
                  <ComposerAction
                    icon="send"
                    label={t(isSending ? 'chat.sending' : 'chat.send')}
                    primary
                    busy={isSending}
                    disabled={draft.trim().length === 0 || isSending}
                    align="end"
                    onClick={() => void submit()}
                  />
                ) : null}
              </div>
            </div>
          </div>
          <span role="status" className="wa-sr-only">{isSending ? t('chat.sending') : ''}</span>
        </div>
      )}
    </div>
  );
};
