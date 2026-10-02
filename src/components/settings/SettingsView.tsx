import { useCallback, useEffect, useMemo, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { copyToClipboard } from 'twenty-sdk/front-component';
import { Tag } from 'twenty-ui/data-display';
import { useTheme } from 'twenty-ui/theme-constants';

import { useCopy } from '../common/copy';
import { relativeTime } from '../common/format';
import { Glyph } from '../common/icons';
import {
  ActionButton,
  Banner,
  Card,
  Field,
  StatusPill,
  TabPanel,
  Tabs,
  useInputStyle,
} from '../common/ui';
import { describeHealth } from './health-detail';
import { VariablesPanel, type EditableVariable } from './VariablesPanel';

/**
 * *Settings → Applications → WhatsApp* (FR-ACC-1 … FR-ACC-5, NFR-O3).
 *
 * The operator's surface, and the only one that talks to the admin routes
 * rather than the feed. Everything it shows is admin-shaped — the routing
 * identity of the number, the health rows, the failed webhook deliveries — and
 * every route it calls re-checks the admin role regardless of what this
 * component chose to render.
 *
 * The verify token is never displayed. The card says whether one is configured
 * and nothing more: a settings page that printed it would put a secret into
 * every screenshot attached to a support ticket.
 */

type Account = Record<string, any>;
type HealthRow = { key: string; ok: boolean; detail: Record<string, any> };

type Diagnostics = {
  accounts: Account[];
  rows: HealthRow[];
  webhook: {
    callbackUrl: string | null;
    directUrl: string | null;
    verifyUrl: string | null;
    verifyTokenConfigured: boolean;
    requiredFields: string[];
  };
  failedEvents: Record<string, any>[];
  stuckOutbound: Record<string, any>[];
  /** Outbound sends the app itself refused or Meta rejected (D-65). */
  failedOutbound: Record<string, any>[];
};

/**
 * The order the panel reads in, and the only place a row key is written down.
 * Each has a `settings.health.<key>` name and a `.remedy` in the catalog: a red
 * light with no instructions sends the operator to the source code.
 */
const HEALTH_KEYS = [
  'token',
  'webhook',
  'quality',
  'tier',
  'failedWebhookEvents',
  'stuckOutbound',
  'failedOutbound',
  'consentWording',
] as const;

/**
 * Whether the server's own address is one Meta could never reach.
 *
 * On local development `TWENTY_API_URL` is the internal `http://localhost:3000`,
 * so the callback card printed a URL that pasting into Meta silently breaks —
 * the tunnel URL the operator actually needs was nowhere on the page. Exported
 * for the test: the list of names that count as "local" is the whole judgement.
 */
export const isLocalCallback = (url: string | null): boolean => {
  if (url === null) return false;

  const host = url.replace(/^[a-z]+:\/\//i, '').split(/[/:]/)[0]?.toLowerCase() ?? '';

  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === 'host.docker.internal' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost')
  );
};

/** The path of an absolute URL the server printed, for the local-tunnel note. */
export const pathOf = (url: string | null): string => {
  if (url === null) return '';

  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

const Copyable = ({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string | null;
  copyLabel: string;
}) => {
  const theme = useTheme();

  if (value === null) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[2] }}>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' }}>
        <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.light }}>
          {label}
        </span>
        <code
          style={{
            fontSize: theme.font.size.sm,
            color: theme.font.color.secondary,
            overflowX: 'auto',
            whiteSpace: 'nowrap',
          }}
        >
          {value}
        </code>
      </div>
      {/* Copying a URL changes nothing, so it is not one of the gated actions. */}
      <ActionButton label={copyLabel} onClick={() => void copyToClipboard(value)} />
    </div>
  );
};

export const SettingsView = () => {
  const theme = useTheme();
  const input = useInputStyle();
  const { t, lang } = useCopy();

  const client = useMemo(() => new RestApiClient(), []);
  const [tab, setTab] = useState('connection');
  const [data, setData] = useState<Diagnostics | null>(null);
  const [templates, setTemplates] = useState<Record<string, any>[]>([]);
  /**
   * Published-state filter for the template list. "Which templates can reps
   * actually use" is the question this tab answers, and with a few dozen
   * synced templates the publish state was one button-label per row — scanning
   * for it was the only way to know.
   */
  const [templateFilter, setTemplateFilter] = useState<'all' | 'published' | 'unpublished'>(
    'all',
  );
  const [variables, setVariables] = useState<EditableVariable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The workspace refused this caller (D-66). Every action here needs the
   * WhatsApp admin role, and the page opens by reading diagnostics — so one
   * 403 on load is enough to know that none of the buttons can work, and to
   * say so once instead of once per click.
   */
  const [forbidden, setForbidden] = useState(false);

  /**
   * The account id whose disconnect is one click from happening. No portals
   * means no modal, so the confirmation is an inline second step: the danger
   * button arms it, and only the explicit confirm actually posts.
   */
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<string | null>(null);

  /** Failed deliveries the operator has ticked for replay. */
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);

  /**
   * How many failed deliveries a bulk replay would re-drive, once asked.
   *
   * `null` means the question has not been asked yet, so the button is still
   * armed rather than confirmed. The count comes from the route's dry run
   * because "replay all failed" over a week of a bad token is thousands of jobs
   * from one click, and the number is the whole point of the confirmation.
   */
  const [pendingReplay, setPendingReplay] = useState<number | null>(null);

  const [form, setForm] = useState({
    name: '',
    wabaId: '',
    phoneNumberId: '',
    defaultCountryCallingCode: '+244',
    isTestAccount: false,
    subscribeApp: true,
  });

  /**
   * In-flight edits to a connected number's calling code, keyed by account id.
   *
   * Kept out of `form`, which belongs to the *connect* card: an operator fixing
   * a wrong code on a live number is not half-way through connecting a new one,
   * and sharing the state would let one card's Save read the other's input. A
   * missing key means "not being edited", so the input falls back to the stored
   * value and a reload after Save is visible rather than overwritten.
   */
  const [callingCodeEdits, setCallingCodeEdits] = useState<Record<string, string>>({});

  const account = data?.accounts[0] ?? null;
  const now = new Date();

  /**
   * Every button on this page, gated on the role the routes require (D-66).
   *
   * Written as one wrapper rather than as `disabled={forbidden || …}` on
   * sixteen call sites, because sixteen places to remember is fifteen places to
   * forget — and the one that was forgotten is how a viewer who could change
   * nothing was invited to provision a notification workflow.
   *
   * A disabled button is still a courtesy and never a control: every route
   * re-checks the role, which is why this can be derived from a refusal the
   * page happened to see rather than from a permission it was told about.
   */
  const AdminAction = useMemo(
    () =>
      /**
       * Memoised on `forbidden` alone, so the component *type* is stable across
       * the renders this page does constantly — typing in the connect form is
       * one. A closure redefined every render is a new type every render, and
       * React unmounts and remounts everything under it: buttons would lose
       * focus and blink out of their loading state mid-click.
       */
      ({ disabled = false, ...props }: Parameters<typeof ActionButton>[0]) => (
        <ActionButton {...props} disabled={disabled || forbidden} />
      ),
    [forbidden],
  );

  /**
   * Returns `null` **and only null** when the request failed, having already
   * put the reason on screen. Every caller must check it before claiming
   * anything happened: the Test and Sync buttons used to announce success
   * unconditionally, so a refused request showed the operator a red error and a
   * green confirmation of the same click.
   *
   * It clears the previous notice too. A success message left over from the
   * last action is indistinguishable from one about this one.
   */
  const post = useCallback(
    async <T,>(path: string, body: Record<string, unknown>): Promise<T | null> => {
      setBusy(true);
      setError(null);
      setNotice(null);

      try {
        const result = await client.post<T>(path, body);

        setForbidden(false);

        return result;
      } catch (caught) {
        const detail = caught as { status?: number; body?: { error?: string } };

        /**
         * A refusal is remembered, not just announced (D-66).
         *
         * Every action on this page requires the WhatsApp admin role, and the
         * page had no idea whether the person reading it had one — so a
         * viewer who could not perform a single action was shown every button,
         * enabled, and learned the truth one click and one red banner at a
         * time. The first refused request is the answer, and it arrives on
         * load: the page opens by reading diagnostics.
         */
        if (detail?.status === 403) setForbidden(true);

        setError(
          detail?.body?.error ??
            (caught instanceof Error ? caught.message : String(caught)),
        );

        return null;
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  const load = useCallback(async () => {
    const result = await post<Diagnostics>('/s/whatsapp/account', { action: 'diagnostics' });

    if (result !== null) setData(result);
  }, [post]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadTemplates = useCallback(async () => {
    if (account === null) return;

    const result = await post<{ templates: Record<string, any>[] }>('/s/whatsapp/template', {
      action: 'list',
      accountId: account.id,
    });

    if (result !== null) setTemplates(result.templates);
  }, [account, post]);

  useEffect(() => {
    if (tab === 'templates') void loadTemplates();
  }, [tab, loadTemplates]);

  const loadVariables = useCallback(async () => {
    const result = await post<{ variables: EditableVariable[] }>('/s/whatsapp/account', {
      action: 'variables',
    });

    if (result !== null) setVariables(result.variables);
  }, [post]);

  useEffect(() => {
    if (tab === 'variables') void loadVariables();
  }, [tab, loadVariables]);

  const rowsFor = (key: string): HealthRow[] =>
    (data?.rows ?? []).filter((row) => row.key === key);

  type ReplayResult = {
    requested?: number;
    matching?: number;
    replayed: number;
    jobs: number;
    truncated?: boolean;
  };

  /**
   * Announces what actually happened, then reloads.
   *
   * The reload is not cosmetic: a replayed row goes back to `RECEIVED`, so it
   * leaves this list — which is how an operator can tell a replay that was
   * queued from one that was refused, without reading a log.
   */
  const announceReplay = useCallback(
    async (result: ReplayResult | null, requested: number) => {
      if (result === null) return;

      setSelectedEvents([]);
      setPendingReplay(null);

      const message = t('settings.replayDone', {
        replayed: result.replayed,
        requested: result.requested ?? result.matching ?? requested,
        jobs: result.jobs,
      });

      await load();

      setNotice(
        result.truncated === true
          ? `${message} ${t('settings.replayTruncated', { cap: requested })}`
          : message,
      );
    },
    [load, t],
  );

  const replaySelected = useCallback(async () => {
    const eventIds = selectedEvents;

    if (eventIds.length === 0) return;

    await announceReplay(
      await post<ReplayResult>('/s/whatsapp/replay', { action: 'replay', eventIds }),
      eventIds.length,
    );
  }, [announceReplay, post, selectedEvents]);

  /**
   * Two steps, and the first one is a question to the server rather than to the
   * operator: the dry run returns the count, and only the second click replays.
   */
  const armReplayAll = useCallback(async () => {
    const result = await post<{ matching: number; wouldReplay: number }>(
      '/s/whatsapp/replay',
      { action: 'replayFailed', dryRun: true },
    );

    if (result === null) return;

    if (result.matching === 0) {
      setNotice(t('settings.replayNothing'));

      return;
    }

    setPendingReplay(result.wouldReplay);
  }, [post, t]);

  /**
   * D-10 layer 3. The button provisions a draft; the notes are what the
   * operator still has to decide, and they stay on screen because the workflow
   * does nothing until they act on them.
   */
  const [reviewNotes, setReviewNotes] = useState<string[]>([]);

  const createNotificationWorkflow = useCallback(async () => {
    const result = await post<{
      name: string;
      existed: boolean;
      reviewNotes: string[];
    }>('/s/whatsapp/account', { action: 'createNotificationWorkflow' });

    if (result === null) return;

    setReviewNotes(result.reviewNotes ?? []);
    setNotice(
      t(
        result.existed
          ? 'settings.notificationWorkflowExisted'
          : 'settings.notificationWorkflowCreated',
        { name: result.name },
      ),
    );
  }, [post, t]);

  const replayAllFailed = useCallback(async () => {
    const cap = pendingReplay ?? 0;

    await announceReplay(
      await post<ReplayResult>('/s/whatsapp/replay', {
        action: 'replayFailed',
        dryRun: false,
      }),
      cap,
    );
  }, [announceReplay, pendingReplay, post]);

  return (
    <div
      className="wa-settings"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        background: theme.background.primary,
        color: theme.font.color.primary,
        fontFamily: theme.font.family,
        padding: theme.spacing[2],
      }}
    >
      <Tabs
        group="settings"
        label={t('settings.tab.connection')}
        active={tab}
        onSelect={setTab}
        tabs={[
          { key: 'connection', label: t('settings.tab.connection') },
          { key: 'health', label: t('settings.tab.health') },
          { key: 'templates', label: t('settings.tab.templates') },
          { key: 'variables', label: t('settings.tab.variables') },
          { key: 'diagnostics', label: t('settings.tab.diagnostics') },
        ]}
      />

      {/*
        Said once, at the top, instead of once per click (D-66). The page reads
        diagnostics on load, so the refusal is known before the reader has
        pressed anything.
      */}
      {forbidden ? <Banner tone="danger">{t('settings.needsAdminRole')}</Banner> : null}
      {error === null ? null : <Banner tone="danger">{error}</Banner>}
      {notice === null ? null : <Banner tone="success">{notice}</Banner>}

      {tab === 'connection' ? (
        <TabPanel group="settings" tabKey="connection">
          {(data?.accounts ?? []).map((connected) => (
            <Card
              key={connected.id}
              title={`${connected.name ?? '—'} · ${connected.displayPhoneNumber ?? ''}`}
              actions={<StatusPill status={connected.status ?? null} />}
            >
              <div style={{ fontSize: theme.font.size.md, color: theme.font.color.secondary }}>
                {t('settings.summary', {
                  displayName: String(connected.displayName ?? '—'),
                  quality: String(connected.qualityRating ?? '—'),
                  tier: String(connected.messagingLimitTier ?? '—'),
                })}
                {connected.isTestAccount === true ? ` · ${t('chat.testAccount')}` : ''}
              </div>
              <Copyable
                label="phone_number_id"
                value={connected.phoneNumberId ?? null}
                copyLabel={t('common.copy')}
              />
              <Copyable
                label="WABA id"
                value={connected.wabaId ?? null}
                copyLabel={t('common.copy')}
              />

              {/*
                Editable here, and not only in the connect form. The value is
                the prefix put in front of every nationally-formatted contact
                number, so a wrong one breaks sends to exactly the contacts it
                was meant to rescue — and until this field existed the only
                repair was Twenty's GraphQL API.
              */}
              <Field label={t('settings.callingCode')} hint={t('settings.callingCodeHint')}>
                <div style={{ display: 'flex', gap: theme.spacing[2], alignItems: 'center' }}>
                  <input
                    type="text"
                    value={
                      callingCodeEdits[connected.id] ??
                      (connected.defaultCountryCallingCode ?? '')
                    }
                    placeholder={t('settings.callingCodeInherited')}
                    onChange={(event) =>
                      setCallingCodeEdits({
                        ...callingCodeEdits,
                        [connected.id]: event.target.value,
                      })
                    }
                    style={input}
                  />
                  <AdminAction
                    label={t('common.save')}
                    busy={busy}
                    disabled={callingCodeEdits[connected.id] === undefined}
                    onClick={async () => {
                      const saved = await post('/s/whatsapp/account', {
                        action: 'updateAccount',
                        accountId: connected.id,
                        defaultCountryCallingCode: callingCodeEdits[connected.id],
                      });

                      if (saved === null) return;

                      // Dropping the key hands the input back to the stored
                      // value, so the operator sees what the server kept —
                      // `+244` from `244` — rather than what they typed.
                      setCallingCodeEdits(
                        Object.fromEntries(
                          Object.entries(callingCodeEdits).filter(
                            ([id]) => id !== connected.id,
                          ),
                        ),
                      );
                      setNotice(t('settings.saved'));
                      void load();
                    }}
                  />
                </div>
              </Field>

              <div style={{ display: 'flex', gap: theme.spacing[2], flexWrap: 'wrap' }}>
                <AdminAction
                  label={t('settings.test')}
                  busy={busy}
                  onClick={async () => {
                    const tested = await post('/s/whatsapp/account', {
                      action: 'test',
                      accountId: connected.id,
                    });

                    if (tested === null) return;

                    setNotice(t('settings.tested'));
                    void load();
                  }}
                />
                <AdminAction
                  label={t('settings.syncTemplates')}
                  busy={busy}
                  onClick={async () => {
                    const requested = await post('/s/whatsapp/account', {
                      action: 'syncTemplates',
                      accountId: connected.id,
                    });

                    if (requested === null) return;

                    setNotice(t('settings.syncRequested'));
                  }}
                />
              </div>

              {/*
                Disconnect is not a third maintenance shortcut: it lives alone
                below a divider, says what it will cost, and takes two clicks.
              */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.spacing[2],
                  borderTop: `1px solid ${theme.border.color.light}`,
                  paddingTop: theme.spacing[2],
                  marginTop: theme.spacing[1],
                }}
              >
                <span
                  style={{
                    fontSize: theme.font.size.sm,
                    fontWeight: theme.font.weight.medium,
                    color: theme.font.color.danger,
                  }}
                >
                  {t('settings.dangerZone')}
                </span>
                <span style={{ fontSize: theme.font.size.md, color: theme.font.color.secondary }}>
                  {t('settings.disconnectWarning')}
                </span>
                {confirmingDisconnect === connected.id ? (
                  <div style={{ display: 'flex', gap: theme.spacing[2], flexWrap: 'wrap' }}>
                    <AdminAction
                      label={t('settings.disconnectConfirm')}
                      tone="danger"
                      busy={busy}
                      onClick={async () => {
                        const disconnected = await post('/s/whatsapp/account', {
                          action: 'disconnect',
                          accountId: connected.id,
                        });

                        setConfirmingDisconnect(null);

                        // Reloading after a failure would immediately clear the
                        // error the failure just wrote — the operator sees a
                        // flash and nothing else.
                        if (disconnected !== null) void load();
                      }}
                    />
                    <AdminAction
                      label={t('common.cancel')}
                      onClick={() => setConfirmingDisconnect(null)}
                    />
                  </div>
                ) : (
                  <div style={{ display: 'flex' }}>
                    <AdminAction
                      label={t('settings.disconnect')}
                      tone="danger"
                      busy={busy}
                      onClick={() => setConfirmingDisconnect(connected.id)}
                    />
                  </div>
                )}
              </div>
            </Card>
          ))}

          <Card title={t('settings.connectTitle')}>
            <Field label={t('settings.name')}>
              <input
                type="text"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                style={input}
              />
            </Field>
            <Field label="phone_number_id" hint={t('settings.phoneNumberIdHint')}>
              <input
                type="text"
                value={form.phoneNumberId}
                onChange={(event) => setForm({ ...form, phoneNumberId: event.target.value })}
                style={input}
              />
            </Field>
            <Field label="WABA id">
              <input
                type="text"
                value={form.wabaId}
                onChange={(event) => setForm({ ...form, wabaId: event.target.value })}
                style={input}
              />
            </Field>
            <Field label={t('settings.callingCode')} hint={t('settings.callingCodeHint')}>
              <input
                type="text"
                value={form.defaultCountryCallingCode}
                onChange={(event) =>
                  setForm({ ...form, defaultCountryCallingCode: event.target.value })
                }
                style={input}
              />
            </Field>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: theme.spacing[2],
                fontSize: theme.font.size.md,
                color: theme.font.color.secondary,
              }}
            >
              <input
                type="checkbox"
                checked={form.isTestAccount}
                onChange={(event) => setForm({ ...form, isTestAccount: event.target.checked })}
              />
              {t('settings.isTestAccount')}
            </label>
            <AdminAction
              label={t('settings.connect')}
              tone="primary"
              busy={busy}
              disabled={form.phoneNumberId === '' || form.wabaId === ''}
              onClick={async () => {
                const created = await post('/s/whatsapp/account', {
                  action: 'connect',
                  ...form,
                });

                if (created !== null) void load();
              }}
            />
          </Card>

          <Card title={t('settings.callback')}>
            {/*
              First, because it is the step that decides which URL to paste.
              The direct form is the callback Meta asks for — one URL answering
              both the GET handshake and the POST deliveries; the two below it
              are the legacy alternatives for a Twenty that does not route GET
              to server routes.
            */}
            <Banner>{t('settings.callbackDirectNote')}</Banner>
            {/*
              On local development these URLs answer only on this machine.
              Saying so beside them is the difference between an operator
              pasting a tunnel URL into Meta and pasting `localhost` — which
              fails without an error anywhere they can see.
            */}
            {isLocalCallback(data?.webhook.directUrl ?? null) ? (
              <Banner>
                {t('settings.callbackLocalNote', {
                  path: pathOf(data?.webhook.directUrl ?? null),
                })}
              </Banner>
            ) : null}
            <Copyable
              label={t('settings.directUrl')}
              value={data?.webhook.directUrl ?? null}
              copyLabel={t('common.copy')}
            />
            <Copyable
              label={t('settings.callbackUrl')}
              value={data?.webhook.callbackUrl ?? null}
              copyLabel={t('common.copy')}
            />
            <Copyable
              label={t('settings.verifyUrl')}
              value={data?.webhook.verifyUrl ?? null}
              copyLabel={t('common.copy')}
            />
            {/*
              The alert is an element now, not a character inside the
              translated string, so it renders at icon scale in the theme's own
              danger colour — and cannot be lost in a re-wording.
            */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: theme.spacing[1],
                fontSize: theme.font.size.md,
                color:
                  data?.webhook.verifyTokenConfigured === true
                    ? theme.font.color.secondary
                    : theme.font.color.danger,
              }}
            >
              {data?.webhook.verifyTokenConfigured === true ? null : <Glyph name="warning" />}
              {t('settings.verifyToken')}:{' '}
              {data?.webhook.verifyTokenConfigured === true
                ? t('settings.verifyTokenSet')
                : t('settings.verifyTokenMissing')}
            </div>
            <div style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}>
              {t('settings.requiredFields')}: {(data?.webhook.requiredFields ?? []).join(', ')}
            </div>
            <AdminAction
              label={t('settings.copyFields')}
              onClick={() =>
                void copyToClipboard((data?.webhook.requiredFields ?? []).join('\n'))
              }
            />
          </Card>
        </TabPanel>
      ) : null}

      {tab === 'health' ? (
        <TabPanel group="settings" tabKey="health">
        <Card
          title={t('settings.tab.health')}
          actions={
            <AdminAction label={t('common.refresh')} busy={busy} onClick={() => void load()} />
          }
        >
          {(data?.rows ?? []).length === 0 ? <Banner>{t('common.loading')}</Banner> : null}

          {HEALTH_KEYS.map((key) =>
            rowsFor(key).map((row, index) => (
              <div
                key={`${key}-${index}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.spacing[1],
                  borderTop: `1px solid ${theme.border.color.light}`,
                  paddingTop: theme.spacing[2],
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.spacing[2],
                    fontSize: theme.font.size.md,
                    fontWeight: theme.font.weight.medium,
                  }}
                >
                  <span>{t(`settings.health.${key}`)}</span>
                  <span style={{ flex: '1 1 auto' }} />
                  <Tag
                    color={row.ok ? 'green' : 'red'}
                    text={row.ok ? t('settings.ok') : t('settings.needsAttention')}
                    weight="medium"
                  />
                </div>

                <span
                  style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}
                >
                  {describeHealth(row.key, row.detail, t, lang)}
                </span>

                {/* A red row that does not say what to do is a red light with no
                    instructions — the operator ends up reading the source. */}
                {row.ok ? null : (
                  <span
                    style={{ fontSize: theme.font.size.sm, color: theme.font.color.danger }}
                  >
                    {t(`settings.health.${key}.remedy`)}
                  </span>
                )}
              </div>
            )),
          )}
        </Card>
        </TabPanel>
      ) : null}

      {tab === 'templates' ? (
        <TabPanel group="settings" tabKey="templates">
        <Card
          title={t('settings.tab.templates')}
          actions={
            <AdminAction
              label={t('common.refresh')}
              busy={busy}
              onClick={() => void loadTemplates()}
            />
          }
        >
          {templates.length === 0 ? (
            <span style={{ fontSize: theme.font.size.md, color: theme.font.color.tertiary }}>
              {t('settings.noTemplates')}
            </span>
          ) : (
            <div style={{ display: 'flex', gap: theme.spacing[1], flexWrap: 'wrap' }}>
              {(['all', 'published', 'unpublished'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTemplateFilter(key)}
                  aria-pressed={templateFilter === key}
                  style={{
                    minHeight: '28px',
                    border: `1px solid ${
                      templateFilter === key ? theme.color.blue : theme.border.color.light
                    }`,
                    borderRadius: theme.border.radius.pill,
                    background:
                      templateFilter === key
                        ? theme.background.transparent.blue
                        : 'transparent',
                    color:
                      templateFilter === key
                        ? theme.font.color.primary
                        : theme.font.color.secondary,
                    cursor: 'pointer',
                    fontFamily: theme.font.family,
                    fontSize: theme.font.size.sm,
                    fontWeight:
                      templateFilter === key
                        ? theme.font.weight.medium
                        : theme.font.weight.regular,
                    padding: `0 ${theme.spacing[2]}`,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t(`settings.templateFilter.${key}`)}
                </button>
              ))}
            </div>
          )}

          {templates
            .filter((template) =>
              templateFilter === 'all'
                ? true
                : templateFilter === 'published'
                  ? template.publishedToCrm === true
                  : template.publishedToCrm !== true,
            )
            .map((template) => (
            <div
              key={String(template.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: theme.spacing[2],
                borderTop: `1px solid ${theme.border.color.light}`,
                paddingTop: theme.spacing[2],
                fontSize: theme.font.size.md,
                flexWrap: 'wrap',
              }}
            >
              <span>{String(template.name ?? '—')}</span>
              <span style={{ color: theme.font.color.tertiary }}>
                {String(template.language ?? '')} · {String(template.category ?? '')}
              </span>
              <StatusPill status={(template.status ?? null) as string | null} />
              {/*
                The published state as a tag, not only as the button's label.
                "Publish" on an unpublished row and "Unpublish" on a published
                one differ by two letters, and the state is the thing an
                operator scans this list for.
              */}
              <Tag
                color={template.publishedToCrm === true ? 'green' : 'gray'}
                text={t(
                  template.publishedToCrm === true
                    ? 'settings.published'
                    : 'settings.notPublished',
                )}
                weight="medium"
              />
              {/*
                Meta reports `UNKNOWN` for any template without enough traffic
                to score, which is most of them on a new number. Printing the
                word next to a green APPROVED pill reads as a second, failing
                status; saying nothing is what "no score yet" looks like.
              */}
              {template.qualityScore === null ||
              template.qualityScore === undefined ||
              String(template.qualityScore).toUpperCase() === 'UNKNOWN' ? null : (
                <span style={{ color: theme.font.color.tertiary }}>
                  {t('settings.templateQuality', { score: String(template.qualityScore) })}
                </span>
              )}
              {template.unsupportedReason === null ||
              template.unsupportedReason === undefined ? null : (
                <span style={{ color: theme.font.color.danger }}>
                  {String(template.unsupportedReason)}
                </span>
              )}
              <span style={{ flex: '1 1 auto' }} />

              {template.publishedToCrm === true ? (
                <AdminAction
                  label={t('settings.unpublish')}
                  busy={busy}
                  onClick={async () => {
                    const unpublished = await post('/s/whatsapp/template', {
                      action: 'unpublish',
                      templateId: template.id,
                    });

                    if (unpublished !== null) void loadTemplates();
                  }}
                />
              ) : (
                <AdminAction
                  label={t('settings.publish')}
                  tone="primary"
                  busy={busy}
                  disabled={template.publishRefusal !== null}
                  onClick={async () => {
                    const published = await post('/s/whatsapp/template', {
                      action: 'publish',
                      templateId: template.id,
                    });

                    if (published !== null) void loadTemplates();
                  }}
                />
              )}

              {template.publishRefusal === null ? null : (
                <span
                  style={{
                    width: '100%',
                    fontSize: theme.font.size.sm,
                    color: theme.font.color.tertiary,
                  }}
                >
                  {String(template.publishRefusal)}
                </span>
              )}
            </div>
          ))}
        </Card>
        </TabPanel>
      ) : null}

      {tab === 'variables' ? (
        <TabPanel group="settings" tabKey="variables">
          <VariablesPanel
            variables={variables}
            busy={busy}
            t={t}
            onSave={async (key, value) => {
              const saved = await post<{ variables: EditableVariable[] }>(
                '/s/whatsapp/account',
                { action: 'setVariable', key, value },
              );

              if (saved === null) return false;

              setVariables(saved.variables);
              setNotice(t('settings.variableSaved', { key }));

              return true;
            }}
          />
        </TabPanel>
      ) : null}

      {tab === 'diagnostics' ? (
        <TabPanel group="settings" tabKey="diagnostics">
          <Card
            title={t('settings.failedEvents')}
            actions={
              <div style={{ display: 'flex', gap: theme.spacing[2] }}>
                <AdminAction
                  label={t('settings.replaySelected', { count: selectedEvents.length })}
                  onClick={() => void replaySelected()}
                  disabled={selectedEvents.length === 0}
                  busy={busy}
                  tone="primary"
                />
                {pendingReplay === null ? (
                  <AdminAction
                    label={t('settings.replayAllFailed')}
                    onClick={() => void armReplayAll()}
                    disabled={(data?.failedEvents ?? []).length === 0}
                    busy={busy}
                  />
                ) : (
                  <AdminAction
                    label={t('settings.replayConfirm', { count: pendingReplay })}
                    onClick={() => void replayAllFailed()}
                    busy={busy}
                    tone="danger"
                  />
                )}
              </div>
            }
          >
            <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
              {t('settings.replayNote')}
            </span>
            {(data?.failedEvents ?? []).length === 0 ? (
              <span style={{ fontSize: theme.font.size.md, color: theme.font.color.tertiary }}>
                {t('common.none')}
              </span>
            ) : null}
            {(data?.failedEvents ?? []).map((event) => {
              const id = String(event.id);
              const checked = selectedEvents.includes(id);

              return (
                <label
                  key={id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: theme.spacing[2],
                    fontSize: theme.font.size.sm,
                    color: theme.font.color.secondary,
                    borderTop: `1px solid ${theme.border.color.light}`,
                    paddingTop: theme.spacing[1],
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setSelectedEvents((current) =>
                        checked ? current.filter((entry) => entry !== id) : [...current, id],
                      )
                    }
                  />
                  <span>
                    {String(event.webhookField ?? '—')} ·{' '}
                    {relativeTime(event.receivedAt as string | null, now, lang)} ·{' '}
                    {String(event.error ?? '')} · {t('settings.attempts')}{' '}
                    {Number(event.attemptCount ?? 0)}
                  </span>
                </label>
              );
            })}
          </Card>

          {/*
            Sends that were refused (D-65).

            "Failed deliveries" above is *inbound* — webhook events we could not
            process — and the stuck list below is outbound messages nothing
            moved. A message something decided to fail was in neither, so every
            failed attachment was invisible on the one screen an operator opens
            to ask what is wrong (D-58). The detail is shown in full: the code
            is what groups them, the sentence beside it is what ends the
            investigation.
          */}
          <Card title={t('settings.failedOutbound')}>
            {(data?.failedOutbound ?? []).length === 0 ? (
              <span style={{ fontSize: theme.font.size.md, color: theme.font.color.tertiary }}>
                {t('common.none')}
              </span>
            ) : null}
            {(data?.failedOutbound ?? []).map((message) => (
              <div
                key={String(message.id)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  fontSize: theme.font.size.sm,
                  color: theme.font.color.secondary,
                  borderTop: `1px solid ${theme.border.color.light}`,
                  paddingTop: theme.spacing[1],
                }}
              >
                <span>
                  {String(message.type ?? '—')} · {String(message.errorCode ?? '—')} ·{' '}
                  {relativeTime(message.createdAt as string | null, now, lang)}
                </span>
                {message.errorDetail === null || message.errorDetail === undefined ? null : (
                  <span
                    style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}
                  >
                    {String(message.errorDetail)}
                  </span>
                )}
              </div>
            ))}
          </Card>

          <Card title={t('settings.stuckMessages')}>
            {(data?.stuckOutbound ?? []).length === 0 ? (
              <span style={{ fontSize: theme.font.size.md, color: theme.font.color.tertiary }}>
                {t('common.none')}
              </span>
            ) : null}
            {(data?.stuckOutbound ?? []).map((message) => (
              <div
                key={String(message.id)}
                style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}
              >
                {String(message.id)} ·{' '}
                {relativeTime(message.createdAt as string | null, now, lang)}
              </div>
            ))}
          </Card>

          <Card
            title={t('settings.notifications')}
            actions={
              <AdminAction
                label={t('settings.createNotificationWorkflow')}
                onClick={() => void createNotificationWorkflow()}
                busy={busy}
              />
            }
          >
            <span style={{ fontSize: theme.font.size.md, color: theme.font.color.tertiary }}>
              {t('settings.notificationsNote')}
            </span>
            {reviewNotes.map((note) => (
              <span
                key={note}
                style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}
              >
                • {t(`settings.review.${note}`)}
              </span>
            ))}
          </Card>

          <Card title={t('settings.consent')}>
            <span style={{ fontSize: theme.font.size.md, color: theme.font.color.tertiary }}>
              {t('settings.consentNote')}
            </span>
          </Card>
        </TabPanel>
      ) : null}

      <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}>
        {t('chat.testAccount')}: {t(account?.isTestAccount === true ? 'common.yes' : 'common.no')}
      </span>
    </div>
  );
};
