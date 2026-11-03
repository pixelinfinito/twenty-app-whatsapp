import { useRef, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { ContactCardProjection } from '../../../domain/feed/content';
import type { PersonProjection } from '../../../domain/feed/projection';
import type { Translate } from '../../common/copy';
import { fileSize } from '../../common/format';
import { Glyph } from '../../common/icons';
import { LocationContent } from '../renderers/rich';
import { PanelFooter, TextField } from './fields';
import { FileUpload } from './FileUpload';
import type { SelectedFile } from './upload';

/**
 * The three sends that need a small form rather than a text box: a location, a
 * contact card, and a device upload or recent conversation file.
 *
 * All three follow the same rule as the interactive builders — validate before
 * queueing, because a message that becomes a `QUEUED` row and then fails inside
 * the sender is a bubble the rep believes was sent.
 */

export type LocationPanelProps = {
  t: Translate;
  isSending: boolean;
  onCancel: () => void;
  onSend: (location: {
    latitude: number;
    longitude: number;
    name: string | null;
    address: string | null;
  }) => Promise<boolean>;
};

const finite = (value: string): number | null => {
  const trimmed = value.trim().replace(',', '.');

  if (trimmed.length === 0) return null;

  const parsed = Number(trimmed);

  return Number.isFinite(parsed) ? parsed : null;
};

export const LocationPanel = ({ t, isSending, onCancel, onSend }: LocationPanelProps) => {
  const theme = useTheme();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [attempted, setAttempted] = useState(false);

  const lat = finite(latitude);
  const lon = finite(longitude);

  /**
   * The same range check the route runs. A transposed pair is accepted by Meta
   * and drops the customer in the Atlantic — the silent failure FR-CID-2 treats
   * as the worst kind — so it is refused in both places rather than trusted to
   * either.
   */
  const valid = lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

  const submit = () => {
    setAttempted(true);

    if (!valid || isSending) return;

    onSend({
      latitude: lat,
      longitude: lon,
      name: name.trim().length === 0 ? null : name.trim(),
      address: address.trim().length === 0 ? null : address.trim(),
    });
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        padding: theme.spacing[2],
        flex: '1 1 auto',
        minHeight: 0,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[2], overflowY: 'auto', minHeight: 0, flex: '1 1 auto' }}>
      <div style={{ display: 'flex', gap: theme.spacing[2], flexWrap: 'wrap' }}>
        <span style={{ flex: '1 1 120px', minWidth: 0 }}>
          <TextField
            disabled={isSending}
            id="wa-location-latitude"
            label={t('chat.latitude')}
            value={latitude}
            inputMode="decimal"
            placeholder="-8.9126"
            onChange={setLatitude}
            t={t}
          />
        </span>
        <span style={{ flex: '1 1 120px', minWidth: 0 }}>
          <TextField
            disabled={isSending}
            id="wa-location-longitude"
            label={t('chat.longitude')}
            value={longitude}
            inputMode="decimal"
            placeholder="13.2334"
            onChange={setLongitude}
            t={t}
          />
        </span>
      </div>

      <TextField
            disabled={isSending}
        id="wa-location-name"
        label={t('chat.locationName')}
        value={name}
        onChange={setName}
        t={t}
      />
      <TextField
            disabled={isSending}
        id="wa-location-address"
        label={t('chat.locationAddress')}
        value={address}
        onChange={setAddress}
        t={t}
      />

      {attempted && !valid ? (
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
          {t('chat.coordinatesRequired')}
        </span>
      ) : null}

      {/* The transcript's own card, so the preview cannot describe it differently. */}
      {valid ? (
        <LocationContent
          name={name.trim().length === 0 ? null : name.trim()}
          address={address.trim().length === 0 ? null : address.trim()}
          latitude={lat}
          longitude={lon}
          t={t}
        />
      ) : null}

      </div>
      <PanelFooter
        busy={isSending}
        submitLabel={t('chat.sendLocation')}
        onCancel={onCancel}
        onSubmit={submit}
        disabled={isSending || (attempted && !valid)}
        t={t}
      />
    </div>
  );
};

export type ContactPanelProps = {
  t: Translate;
  isSending: boolean;
  /** The conversation's own CRM contact, offered as a one-tap starting point. */
  person: PersonProjection | null;
  onCancel: () => void;
  onSend: (contact: ContactCardProjection) => Promise<boolean>;
};

export const ContactPanel = ({ t, isSending, person, onCancel, onSend }: ContactPanelProps) => {
  const theme = useTheme();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [organization, setOrganization] = useState('');
  const [attempted, setAttempted] = useState(false);

  const valid = name.trim().length > 0;

  const submit = () => {
    setAttempted(true);

    if (!valid || isSending) return;

    onSend({
      formattedName: name.trim(),
      firstName: name.trim().split(' ')[0] ?? null,
      lastName: null,
      organization: organization.trim().length === 0 ? null : organization.trim(),
      title: null,
      phones: phone.trim().length === 0 ? [] : [{ phone: phone.trim(), waId: null, type: 'CELL' }],
      emails: [],
    });
  };

  const personName = [person?.firstName, person?.lastName]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        padding: theme.spacing[2],
        flex: '1 1 auto',
        minHeight: 0,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[2], overflowY: 'auto', minHeight: 0, flex: '1 1 auto' }}>
      {/*
        A shortcut, not a picker. Twenty exposes no record-search widget to a
        front component, so offering "search your contacts" would be a control
        that could not be built — where prefilling from the conversation's own
        person is one tap and always correct.
      */}
      {personName.length === 0 ? null : (
        <button
          type="button"
          onClick={() => {
            setName(personName);
            setPhone(person?.primaryPhone ?? '');
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            alignSelf: 'flex-start',
            gap: theme.spacing[1],
            minHeight: '32px',
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
          <Glyph name="mine" />
          {t('chat.useThisPerson')}: {personName}
        </button>
      )}

      <TextField
            disabled={isSending}
        id="wa-contact-name"
        label={t('chat.contactName')}
        value={name}
        onChange={setName}
        t={t}
      />
      <TextField
            disabled={isSending}
        id="wa-contact-phone"
        label={t('chat.contactPhone')}
        value={phone}
        inputMode="tel"
        onChange={setPhone}
        t={t}
      />
      <TextField
            disabled={isSending}
        id="wa-contact-organization"
        label={t('chat.contactOrganization')}
        value={organization}
        onChange={setOrganization}
        t={t}
      />

      {attempted && !valid ? (
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
          {t('chat.contactNameRequired')}
        </span>
      ) : null}

      </div>
      <PanelFooter
        busy={isSending}
        submitLabel={t('chat.sendContact')}
        onCancel={onCancel}
        onSubmit={submit}
        disabled={isSending || (attempted && !valid)}
        t={t}
      />
    </div>
  );
};

/** A file already exchanged in this conversation, offered for reuse. */
export type RecentAttachment = {
  fileId?: string;
  url: string;
  filename: string | null;
  mediaKind: 'image' | 'video' | 'audio' | 'document';
  sizeBytes: number | null;
};

export type AttachmentPanelProps = {
  t: Translate;
  isSending: boolean;
  initialKind: 'image' | 'document';
  recentFiles?: RecentAttachment[];
  fieldMetadataId?: string | null;
  onCancel: () => void;
  onSend: (input: {
    mediaKind: 'image' | 'video' | 'audio' | 'document';
    fileId?: string;
    fileUrl?: string;
    filePath?: string;
    filename: string | null;
    caption: string | null;
  }) => Promise<boolean>;
};

export const AttachmentPanel = ({
  t,
  isSending,
  initialKind,
  recentFiles = [],
  fieldMetadataId,
  onCancel,
  onSend,
}: AttachmentPanelProps) => {
  const theme = useTheme();
  const [source, setSource] = useState<'device' | 'recent'>('device');
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [recentKey, setRecentKey] = useState('');
  const keyFor = (file: RecentAttachment) => file.fileId ?? file.url.split('?')[0]!;
  const recent = recentFiles.find((file) => keyFor(file) === recentKey) ?? null;
  const [caption, setCaption] = useState('');
  const submitted = useRef(false);
  const activeKind = source === 'device' ? selected?.mediaKind : recent?.mediaKind;
  const ready = source === 'device' ? selected !== null : recent !== null;
  const submit = async () => {
    if (!ready || isSending || submitted.current) return;
    submitted.current = true;
    try {
    const text = activeKind === 'audio' ? null : caption.trim() || null;
    if (source === 'device' && selected) {
      await onSend({
        mediaKind: selected.mediaKind,
        fileId: selected.fileId,
        fileUrl: selected.url,
        filePath: selected.path,
        filename: selected.filename,
        caption: text,
      });
    } else if (recent) {
      await onSend({
        mediaKind: recent.mediaKind,
        fileUrl: recent.url,
        filename: recent.filename,
        caption: text,
      });
    }
    } finally {
      submitted.current = false;
    }
  };
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[1],
        flex: '1 1 auto',
        padding: theme.spacing[2],
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {recentFiles.length > 0 ? (
        <div style={{ display: 'flex', gap: theme.spacing[1], flexShrink: 0 }}>
          {(['device', 'recent'] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              aria-pressed={source === entry}
              style={{
                border: `1px solid ${source === entry ? theme.color.blue : theme.border.color.medium}`,
                borderRadius: theme.border.radius.sm,
                background: 'transparent',
                color: theme.font.color.primary,
                font: 'inherit',
                padding: '4px 8px',
              }}
              disabled={isSending}
              onClick={() => setSource(entry)}
            >
              {t(entry === 'device' ? 'upload.device' : 'chat.source.recent')}
            </button>
          ))}
        </div>
      ) : null}
      {source === 'device' ? (
        <FileUpload
          t={t}
          fieldMetadataId={fieldMetadataId}
          value={selected}
          onChange={setSelected}
          requiredKind={initialKind === 'document' ? 'document' : undefined}
          disabled={isSending}
        />
      ) : (
        <select
          aria-label={t('chat.source.recent')}
          value={recentKey}
          disabled={isSending}
          onChange={(event) => setRecentKey(event.target.value)}
          style={{
            minWidth: 0,
            width: '100%',
            minHeight: 32,
            flexShrink: 0,
            border: `1px solid ${theme.border.color.medium}`,
            borderRadius: theme.border.radius.sm,
            color: theme.font.color.primary,
            background: theme.background.secondary,
            font: 'inherit',
          }}
        >
          <option value="">{t('upload.chooseRecent')}</option>
          {recentFiles.map((file) => (
            <option key={keyFor(file)} value={keyFor(file)}>
              {file.filename ?? t(`chat.type.${file.mediaKind.toUpperCase()}`)}
              {file.sizeBytes === null ? '' : ` · ${fileSize(file.sizeBytes)}`}
            </option>
          ))}
        </select>
      )}

      {activeKind !== 'audio' ? (
        <div style={{ flexShrink: 0 }}>
          <TextField
            disabled={isSending}
            id="wa-attach-caption"
            label={t('chat.captionLabel')}
            value={caption}
            rows={1}
            maxLength={1024}
            onChange={setCaption}
            t={t}
          />
        </div>
      ) : null}
      <div style={{ flexShrink: 0 }}>
        <PanelFooter
        busy={isSending}
          submitLabel={t('chat.sendAttachment')}
          submitIcon="attachment"
          onCancel={onCancel}
          onSubmit={() => void submit()}
          disabled={isSending || !ready}
          t={t}
        />
      </div>
    </div>
  );
};
