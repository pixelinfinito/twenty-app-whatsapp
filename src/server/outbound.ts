import {
  DIRECTION,
  LANE,
  MESSAGE_STATUS,
  MESSAGE_TYPE,
  SOURCE_KIND,
  type Lane,
  type MessageType,
  type SourceKind,
  type TemplateCategory,
} from '../domain/constants';
import type { SendSpec } from '../domain/send-spec';
import { copyMessageMedia } from './retained-media';
import type { ResolvedParameters } from '../domain/template-render';
import { scheduleSend } from './schedule';
import type { WhatsappAccountRecord } from './repositories/accounts';
import { createMessage, type WhatsappMessageRecord } from './repositories/messages';
import type { WhatsappThreadRecord } from './repositories/threads';

/**
 * Turning an intention to send into a queued message and a scheduled job.
 *
 * Four callers produce outbound messages — the composer route, the consent
 * keyword handler, the workflow action and the campaign runner — and all four
 * need the same three things done in the same order: a `QUEUED` record, a lane
 * slot, a job. Writing that out four times is how the fourth one ends up
 * missing the cursor update and quietly bursting past the throttle.
 *
 * The policy gate is **not** called here. That is deliberate: each caller
 * decides what to do with a denial (a 409 for the composer, a `denied` step
 * output for a workflow, an excluded recipient for a campaign), and the binding
 * re-check happens in the sender anyway. A helper that silently swallowed a
 * denial would make those differences invisible.
 */

export const MESSAGE_TYPE_FOR_KIND: Record<string, MessageType> = {
  text: MESSAGE_TYPE.TEXT,
  image: MESSAGE_TYPE.IMAGE,
  video: MESSAGE_TYPE.VIDEO,
  audio: MESSAGE_TYPE.AUDIO,
  document: MESSAGE_TYPE.DOCUMENT,
  sticker: MESSAGE_TYPE.STICKER,
  template: MESSAGE_TYPE.TEMPLATE,
  interactive: MESSAGE_TYPE.INTERACTIVE,
  reaction: MESSAGE_TYPE.REACTION,
  location: MESSAGE_TYPE.LOCATION,
  contacts: MESSAGE_TYPE.CONTACTS,
};

export const messageTypeForSpec = (spec: SendSpec): MessageType =>
  spec.kind === 'media'
    ? (MESSAGE_TYPE_FOR_KIND[spec.mediaKind] ?? MESSAGE_TYPE.DOCUMENT)
    : (MESSAGE_TYPE_FOR_KIND[spec.kind] ?? MESSAGE_TYPE.TEXT);

export type QueueOutboundInput = {
  thread: WhatsappThreadRecord;
  account: WhatsappAccountRecord;
  spec: SendSpec;
  /** The rendered text stored for display; null for media with no caption. */
  body?: string | null;
  lane?: Lane;
  sourceKind?: SourceKind;
  sentById?: string | null;
  clientToken?: string | null;
  template?: {
    id: string;
    name?: string | null;
    language?: string | null;
    category?: string | null;
    parameters?: ResolvedParameters | null;
  } | null;
  /** Skip the scheduler — the campaign runner paces a whole batch at once. */
  schedule?: boolean;
};

export const queueOutbound = async ({
  thread,
  account,
  spec,
  body = null,
  lane = LANE.INTERACTIVE,
  sourceKind = SOURCE_KIND.AGENT,
  sentById = null,
  clientToken = null,
  template = null,
  schedule = true,
}: QueueOutboundInput): Promise<WhatsappMessageRecord> => {
  // Reused files cannot be attached twice in Twenty: copy them into the new message field.
  if (sourceKind !== SOURCE_KIND.CAMPAIGN) {
    if (spec.kind === 'media' && !spec.fileId && (spec.fileUrl || spec.filePath)) {
      const copied = await copyMessageMedia(
        { url: spec.fileUrl, path: spec.filePath },
        spec.filename ?? 'Media',
        spec.mediaKind,
      );
      spec = { ...spec, fileId: copied.id, filePath: copied.path, fileUrl: null };
    } else if (
      template?.parameters?.header?.kind === 'media' &&
      !template.parameters.header.fileId &&
      !template.parameters.header.mediaId
    ) {
      const header = template.parameters.header;
      if (header.fileUrl || header.filePath) {
        const copied = await copyMessageMedia(
          { url: header.fileUrl, path: header.filePath },
          header.filename ?? 'Header media',
          'document',
        );
        template = {
          ...template,
          parameters: {
            ...template.parameters,
            header: { ...header, fileId: copied.id, filePath: copied.path, fileUrl: null },
          },
        };
      }
    }
  }
  const header = template?.parameters?.header;
  const fileId =
    spec.kind === 'media' ? spec.fileId : header?.kind === 'media' ? header.fileId : null;
  const filename =
    spec.kind === 'media' ? spec.filename : header?.kind === 'media' ? header.filename : null;
  const message = await createMessage({
    ...(fileId && sourceKind !== SOURCE_KIND.CAMPAIGN
      ? { mediaFile: [{ fileId, label: filename ?? 'Media' }] }
      : {}),
    ...(fileId
      ? {
          mediaMeta: {
            filename: filename ?? 'Media',
            ...(spec.kind === 'media' ? { voice: spec.voice === true } : {}),
          },
        }
      : {}),
    threadId: thread.id,
    direction: DIRECTION.OUTBOUND,
    messageType: messageTypeForSpec(spec),
    body,
    payload: spec as unknown as Record<string, unknown>,
    status: MESSAGE_STATUS.QUEUED,
    lane,
    sourceKind,
    waTimestamp: new Date().toISOString(),
    sentById,
    ...(clientToken === null ? {} : { clientToken }),
    ...(spec.kind === 'reaction' ? { reactionTargetWamid: spec.targetWamid } : {}),
    ...('contextWamid' in spec && typeof spec.contextWamid === 'string'
      ? { contextWamid: spec.contextWamid }
      : {}),
    ...(template === null
      ? {}
      : {
          templateId: template.id,
          templateName: template.name ?? null,
          templateLanguage: template.language ?? null,
          templateCategory: (template.category ?? null) as TemplateCategory | null,
          templateParameters:
            template.parameters === null || template.parameters === undefined
              ? null
              : (template.parameters as unknown as Record<string, unknown>),
        }),
  });

  if (schedule) {
    await scheduleSend({ messageIds: [message.id], lane, account });
  }

  return message;
};
