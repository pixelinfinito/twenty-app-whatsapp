import { useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type {
  ContactCardProjection,
  InteractiveProjection,
  InteractiveReplyProjection,
  TemplateMessageProjection,
} from '../../../domain/feed/content';
import { contactKey } from '../../../domain/feed/contact-match';
import type { Translate } from '../../common/copy';
import { coordinates as formatCoordinates, mapLink } from '../../common/format';
import { Glyph } from '../../common/icons';
import { CardAction, ContentCard, ContentTag } from './primitives';

/**
 * Everything that is not a file (spec §"Location and vCard design",
 * §"Interactive-message authoring").
 *
 * Each of these types already arrived correctly and each rendered as something
 * a rep could not use: a location as `-8.9126, 13.2334`, a shared contact as a
 * bare name, an interactive reply as ordinary text. The renderers below are the
 * product decision the transcript was missing, not new data.
 */

/**
 * Plain text, with the links in it made clickable.
 *
 * Deliberately conservative: only `http(s)://` and bare `www.` runs become
 * links, and the visible text is never rewritten. A linkifier that also matched
 * bare domains turns "veja o ficheiro final.pdf" into a link to a `.pdf`
 * top-level domain, which is a thing that exists.
 */
const LINK = /((?:https?:\/\/|www\.)[^\s<>"']+)/g;

export const TextContent = ({ body }: { body: string }) => {
  const theme = useTheme();

  const parts = body.split(LINK);

  return (
    <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <a
            key={index}
            href={part.startsWith('www.') ? `https://${part}` : part}
            target="_blank"
            rel="noreferrer"
            style={{ color: theme.color.blue, wordBreak: 'break-all' }}
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </span>
  );
};

/**
 * A place, described as a place.
 *
 * No map tile is fetched. The sandbox renders with an opaque origin, so a
 * third-party tile request either fails silently or ships a customer's
 * coordinates to a host nobody in this workspace chose — and a placeholder that
 * says where somewhere *is* beats a grey rectangle that says nothing.
 */
export const LocationContent = ({
  name,
  address,
  latitude,
  longitude,
  t,
}: {
  name: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  t: Translate;
}) => {
  const href = mapLink(latitude, longitude);
  const pair = formatCoordinates(latitude, longitude);

  return (
    <ContentCard
      icon="location"
      title={name ?? address ?? t('chat.locationShared')}
      subtitle={name === null ? null : address}
      meta={pair}
      action={
        href === null ? undefined : (
          <CardAction icon="open" label={t('chat.action.openMap')} href={href} />
        )
      }
    />
  );
};

/**
 * A shared contact card, and what the CRM may do with it.
 *
 * Never auto-created. The data belongs to a third party who did not consent to
 * being in this workspace's CRM, so the card offers the intent and a human
 * confirms it — which is also why **Create person** carries its own warning
 * line rather than being a one-tap action.
 */
export const ContactsContent = ({
  contacts,
  t,
  onCreatePerson,
  creating,
}: {
  contacts: ContactCardProjection[];
  t: Translate;
  /** Absent when the caller may not write to the CRM. */
  onCreatePerson?: (contact: ContactCardProjection) => void;
  /**
   * Cards whose create is in flight. The button has no optimistic state of its
   * own — it stops being offered only when the *server* reports a match, up to
   * one poll later — so without this a second press creates a second person.
   */
  creating?: ReadonlySet<string>;
}) => {
  const theme = useTheme();

  if (contacts.length === 0) {
    return <ContentCard icon="contactCard" title={t('chat.contactShared')} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
      {contacts.map((contact, index) => {
        const name = contact.formattedName ?? contact.firstName ?? t('chat.contactShared');
        const organisation = [contact.title, contact.organization]
          .filter((part): part is string => part !== null)
          .join(' · ');

        const matched = contact.matchedPersonId ?? null;

        return (
          <ContentCard
            key={`${name}-${index}`}
            icon="contactCard"
            title={name}
            subtitle={organisation.length === 0 ? null : organisation}
            meta={
              [
                ...contact.phones.map((phone) => phone.phone),
                ...contact.emails.map((email) => email.email),
              ].join(' · ') || null
            }
            action={
              matched === null ? (
                onCreatePerson === undefined ? undefined : (
                  <CardAction
                    icon="unassigned"
                    label={
                      creating?.has(contactKey(contact)) === true
                        ? t('chat.creatingPerson')
                        : t('chat.createPerson')
                    }
                    disabled={creating?.has(contactKey(contact)) === true}
                    onClick={() => onCreatePerson(contact)}
                  />
                )
              ) : (
                /*
                  A plain link to the record, not a scripted navigation. The
                  sandbox has no router to call and `window.location` is not
                  reliably writable here — an `<a href>` is the one navigation
                  that always works, and it is also the one a rep can
                  middle-click into a new tab.
                */
                <CardAction
                  icon="mine"
                  label={t('chat.openPerson')}
                  href={`/object/person/${matched}`}
                />
              )
            }
          >
            {matched !== null || onCreatePerson === undefined ? null : (
              /*
                The warning belongs on the card, beside the button, not in a
                confirmation the rep will click through. These are a third
                party's details, sent by somebody else, and "review before
                creating" is the whole of the rule (spec §"Shared contacts").
              */
              <span
                style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}
              >
                {t('chat.contactReview')}
              </span>
            )}
          </ContentCard>
        );
      })}
    </div>
  );
};

/**
 * An interactive message we sent, showing the buttons the customer saw.
 *
 * The rows are `div`s and not buttons on purpose: they are a *record* of what
 * was offered, and a clickable button in the transcript would suggest a rep
 * could press it on the customer's behalf.
 */
export const InteractiveContent = ({
  interactive,
  t,
}: {
  interactive: InteractiveProjection;
  t: Translate;
}) => {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);

  const block = (text: string | null, tone: 'strong' | 'normal' | 'quiet') =>
    text === null ? null : (
      <span
        style={{
          fontSize: tone === 'quiet' ? theme.font.size.xs : theme.font.size.sm,
          fontWeight:
            tone === 'strong' ? theme.font.weight.semiBold : theme.font.weight.regular,
          color: tone === 'quiet' ? theme.font.color.secondary : theme.font.color.primary,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </span>
    );

  const optionRow = (label: string, description: string | null, key: string) => (
    <div
      key={key}
      style={{
        display: 'flex',
        flexDirection: 'column',
        border: `1px solid ${theme.border.color.light}`,
        borderRadius: theme.border.radius.sm,
        padding: `${theme.spacing[0.5]} ${theme.spacing[1]}`,
        color: theme.font.color.secondary,
        fontSize: theme.font.size.xs,
      }}
    >
      <span>{label}</span>
      {description === null ? null : (
        <span style={{ color: theme.font.color.secondary }}>{description}</span>
      )}
    </div>
  );

  if (interactive.kind === 'other') {
    return (
      <ContentCard
        icon="quickReplies"
        title={t('chat.type.INTERACTIVE')}
        subtitle={interactive.body}
        meta={interactive.interactiveType}
      />
    );
  }

  const rows =
    interactive.kind === 'list'
      ? interactive.sections.flatMap((section) =>
          section.rows.map((row) => ({ ...row, section: section.title })),
        )
      : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
      <ContentTag
        icon={interactive.kind === 'list' ? 'listMessage' : 'quickReplies'}
        label={
          interactive.kind === 'list'
            ? t('chat.interactiveList')
            : t('chat.interactiveButtons')
        }
      />

      {block(interactive.header, 'strong')}
      {block(interactive.body, 'normal')}
      {block(interactive.footer, 'quiet')}

      {interactive.kind === 'buttons' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[0.5] }}>
          {interactive.buttons.map((button) =>
            optionRow(button.title, null, button.id || button.title),
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[0.5] }}>
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.spacing[1],
              minHeight: '28px',
              border: `1px solid ${theme.border.color.medium}`,
              borderRadius: theme.border.radius.sm,
              background: 'transparent',
              color: theme.font.color.secondary,
              cursor: 'pointer',
              fontFamily: theme.font.family,
              fontSize: theme.font.size.xs,
              padding: `0 ${theme.spacing[2]}`,
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.spacing[1] }}>
              <Glyph name="listMessage" />
              {interactive.buttonText ?? t('chat.viewOptions')}
            </span>
            <span style={{ color: theme.font.color.secondary }}>
              {t('chat.listOptions', { count: rows.length })}
            </span>
          </button>

          {expanded
            ? rows.map((row, index) =>
                optionRow(row.title, row.description, row.id || `${index}`),
              )
            : null}
        </div>
      )}
    </div>
  );
};

/**
 * A customer's answer to an interactive message.
 *
 * The tag is the whole point: it is what makes "Sim" legible as a button the
 * business authored rather than as three characters somebody typed.
 */
export const InteractiveReplyContent = ({
  reply,
  t,
}: {
  reply: InteractiveReplyProjection;
  t: Translate;
}) => {
  const theme = useTheme();

  const label =
    reply.kind === 'button'
      ? t('chat.selectedQuickReply')
      : reply.kind === 'list'
        ? t('chat.selectedFromList')
        : t('chat.flowResponse');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
      <ContentTag
        icon={reply.kind === 'list' ? 'listMessage' : 'quickReplies'}
        label={label}
      />

      {reply.title === null ? null : (
        <span
          style={{
            fontSize: theme.font.size.sm,
            fontWeight: theme.font.weight.medium,
            wordBreak: 'break-word',
          }}
        >
          {reply.title}
        </span>
      )}

      {reply.description === null ? null : (
        <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
          {reply.description}
        </span>
      )}

      {reply.fields.length === 0 ? null : (
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: `${theme.spacing[0.5]} ${theme.spacing[2]}`,
            margin: 0,
            fontSize: theme.font.size.xs,
          }}
        >
          {reply.fields.map((field) => (
            <FieldRow key={field.key} label={field.key} value={field.value} />
          ))}
        </dl>
      )}
    </div>
  );
};

const FieldRow = ({ label, value }: { label: string; value: string }) => {
  const theme = useTheme();

  return (
    <>
      <dt style={{ color: theme.font.color.secondary }}>{label}</dt>
      <dd style={{ margin: 0, color: theme.font.color.secondary, wordBreak: 'break-word' }}>
        {value}
      </dd>
    </>
  );
};

/**
 * A template send, showing what the customer received.
 *
 * The rendered body is stored on the message, so this is faithful to what was
 * actually sent rather than to whatever the template says today — a template
 * re-synced after a send must not silently rewrite history in the transcript.
 */
export const TemplateContent = ({
  template,
  t,
}: {
  template: TemplateMessageProjection;
  t: Translate;
}) => {
  const theme = useTheme();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
      <ContentTag
        icon="template"
        label={
          template.name === null
            ? t('chat.template')
            : `${t('chat.template')}: ${template.name}`
        }
      />
      {template.body === null ? null : <TextContent body={template.body} />}
    </div>
  );
};

/**
 * A system event, centred and quiet: it is a fact about the conversation, not a
 * turn in it, and giving it a bubble makes it look like something somebody said.
 */
export const SystemContent = ({ body, t }: { body: string | null; t: Translate }) => {
  const theme = useTheme();

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.spacing[1],
        fontSize: theme.font.size.xs,
        color: theme.font.color.secondary,
        fontStyle: 'italic',
      }}
    >
      <Glyph name="details" />
      {body ?? t('chat.systemEvent')}
    </span>
  );
};

/**
 * A type this app does not render yet.
 *
 * FR-IN-1 stores everything, so this is a rendering gap and never data loss —
 * and the card says so, names the type, and tells the reader the original is
 * kept. "Unsupported message" alone left a rep unable to tell a bug from a
 * product boundary.
 */
export const UnsupportedContent = ({
  sourceType,
  body,
  t,
}: {
  sourceType: string | null;
  body: string | null;
  t: Translate;
}) => (
  <ContentCard
    icon="consentUnknown"
    title={t('chat.unsupported')}
    subtitle={body ?? t('chat.unsupportedBody')}
    meta={sourceType}
    tone="quiet"
  />
);
