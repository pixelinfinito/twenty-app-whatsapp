import { useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { ResolvedParameters } from '../../domain/template-render';
import type { Translate } from '../common/copy';
import { ActionButton, EmptyState } from '../common/ui';
import type { FeedPolicy, FeedTemplate } from '../common/use-feed';
import type { IconName } from '../common/icons';
import { TemplatePicker } from './TemplatePicker';

/**
 * A contact with no WhatsApp conversation (specs/08 §7, review §"empty state").
 *
 * The screen this replaces said one sentence — "Este contacto ainda não tem
 * conversa de WhatsApp." — in every situation. It was true every time and
 * useful none of them: it read the same whether the contact had unsubscribed,
 * the workspace had no number connected, the contact had no usable phone, or
 * the rep was one click from starting the conversation.
 *
 * So the state branches on the server's own verdict rather than on a guess.
 * `policy` here is evaluated against a conversation that does not exist yet, so
 * its denial *is* the diagnosis: `ACCOUNT_NOT_CONNECTED` is a setup problem,
 * `OPTED_OUT` is a consent problem, and `WINDOW_CLOSED` — the ordinary case —
 * is not a problem at all but the instruction to open with a template.
 *
 * The order matters and follows the gate's own (specs/04 §1): a workspace with
 * no connected number cannot act on consent, so the number is reported first.
 */

export type StartConversationProps = {
  fieldMetadataId?: string | null;
  policy: FeedPolicy | undefined;
  templates: FeedTemplate[];
  /** From the feed: what the send route needs to open a conversation. */
  start: { accountId: string | null; waId: string | null } | undefined;
  canSend: boolean;
  isSending: boolean;
  t: Translate;
  onSendTemplate: (templateId: string, parameters: ResolvedParameters) => Promise<boolean>;
};

type Diagnosis = {
  icon: IconName;
  title: string;
  body: string;
  /** Only the ordinary case offers an action; the rest are somebody else's fix. */
  canStart: boolean;
};

/**
 * Which of the four states this contact is in.
 *
 * Exported and pure: it is the whole of the branching, it has four arms that
 * are easy to get subtly wrong, and every one of them is a different screen a
 * rep will meet on a real contact.
 */
export const diagnoseStart = (
  reason: string | null | undefined,
  hasWaId: boolean,
): Diagnosis => {
  if (reason === 'ACCOUNT_NOT_CONNECTED') {
    return {
      icon: 'settings',
      title: 'chat.setupTitle',
      body: 'chat.setupBody',
      canStart: false,
    };
  }

  if (reason === 'OPTED_OUT' || reason === 'NO_CONSENT' || reason === 'THREAD_BLOCKED') {
    return {
      icon: 'blocked',
      title: 'chat.consentTitle',
      body: 'chat.reviewConsentBody',
      canStart: false,
    };
  }

  /**
   * Checked after the two hard blocks and before the ordinary case: a contact
   * who cannot be reached at all should not be offered a template picker, but
   * "this contact unsubscribed" is the more useful thing to say when both are
   * true.
   */
  if (!hasWaId) {
    return {
      icon: 'consentUnknown',
      title: 'chat.noPhoneTitle',
      body: 'chat.noPhoneBody',
      canStart: false,
    };
  }

  /**
   * The ordinary case, and the only one that offers an action. A first message
   * to anybody is outside a window that has never opened, so `WINDOW_CLOSED`
   * here is not a refusal — it is the instruction to open with a template
   * (FR-OUT-5). `null` is an allowed policy, which cannot happen for a
   * free-form send with no window but costs nothing to honour.
   */
  if (reason === null || reason === undefined || reason === 'WINDOW_CLOSED') {
    return {
      icon: 'template',
      title: 'chat.noThread',
      body: 'chat.noThreadBody',
      canStart: true,
    };
  }

  /**
   * A denial this build has never met — a code from a policy rule added after
   * it shipped. It must not fall through to "start a conversation": the server
   * has said no, and offering the button anyway means the rep composes a
   * template and meets the refusal at the end instead of the start. The denial
   * has its own sentence in the copy table, which `StartConversation` puts
   * above this one.
   */
  return {
    icon: 'warning',
    title: 'chat.blockedTitle',
    body: 'chat.blockedBody',
    canStart: false,
  };
};

export const StartConversation = ({
  fieldMetadataId,
  policy,
  templates,
  start,
  canSend,
  isSending,
  t,
  onSendTemplate,
}: StartConversationProps) => {
  const theme = useTheme();
  const [showPicker, setShowPicker] = useState(false);

  const diagnosis = diagnoseStart(
    policy?.allowed === false ? policy.reason : null,
    typeof start?.waId === 'string' && start.waId.length > 0,
  );

  const offerStart = diagnosis.canStart && canSend && templates.length > 0;

  if (showPicker) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', width: '100%' }}>
        <TemplatePicker
          fieldMetadataId={fieldMetadataId}
          templates={templates}
          t={t}
          isSending={isSending}
          onCancel={() => setShowPicker(false)}
          onSend={async (templateId, parameters) => {
            const accepted = await onSendTemplate(templateId, parameters);
            if (accepted) setShowPicker(false);
            return accepted;
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', margin: 'auto', width: '100%' }}>
      <EmptyState
        icon={diagnosis.icon}
        title={t(diagnosis.title)}
        body={
          diagnosis.canStart
            ? t(diagnosis.body)
            : /*
                The denial's own sentence comes first — "Este contacto cancelou
                a subscrição." — and the explanation of what to do about it
                second. The generic half alone would leave a rep guessing which
                of two consent states they are looking at.
              */
              [
                policy?.allowed === false ? t(`policy.${policy.reason}`) : null,
                t(diagnosis.body),
              ]
                .filter((line): line is string => line !== null)
                .join(' ')
        }
        actions={
          offerStart ? (
            <ActionButton
              label={t('chat.startWithTemplate')}
              tone="primary"
              icon="template"
              onClick={() => setShowPicker(true)}
            />
          ) : diagnosis.canStart && templates.length === 0 ? (
            <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}>
              {t('chat.noTemplates')}
            </span>
          ) : undefined
        }
      />
    </div>
  );
};
