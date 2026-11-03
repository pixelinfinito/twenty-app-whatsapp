import { useCallback, useEffect, useRef, useState } from 'react';
import { openCommandConfirmationModal } from 'twenty-sdk/front-component';
import { useTheme } from 'twenty-ui/theme-constants';

import {
  canArchiveCampaign,
  canDeleteCampaign,
  isArchivedCampaign,
} from '../../domain/campaign/transitions';
import type { Lang, Translate } from '../common/copy';
import { money, relativeTime } from '../common/format';
import { Glyph } from '../common/icons';
import { ActionButton, Banner, Card, StatusPill } from '../common/ui';
import { useCampaignActions } from './campaign-actions';
import { deliveryFunnel, isFinishing, RUNNING_STATUSES } from './list';

/**
 * One campaign: what it will cost, who it will miss, and how to stop it
 * (FR-CAM-6, FR-CAM-8, FR-CAM-10, specs/07 §5).
 *
 * The pre-flight panel is the point of this screen. Everything on it is a
 * number the server computed from the snapshot that will actually be sent —
 * the exclusion breakdown with samples, the cost estimate at the template's own
 * category rate, the tier spread, and the quality gate. A launch button beside
 * a number nobody computed is how a campaign to 40 000 people gets approved by
 * someone who thought it was 400.
 *
 * Pause, resume and cancel go behind the host's confirmation modal — they are
 * the controls a person reaches for while something is going wrong, which is
 * exactly when a misclick is most likely.
 */

export type CampaignDetailProps = {
  campaign: Record<string, any>;
  recipients: Record<string, any>[];
  canManage: boolean;
  canEdit?: boolean;
  t: Translate;
  lang: Lang;
  now: Date;
  onBack: () => void;
  onChanged: () => void;
  /**
   * Back into the builder with this campaign loaded (D-61). A draft used to be
   * readable and not editable, so an interrupted campaign could only be deleted
   * and started again.
   */
  onEdit: () => void;
  /**
   * Separate from `onChanged` because there is no longer a campaign to refresh:
   * re-reading a deleted campaign answers 404 and the screen would sit on
   * "loading" for a record that is gone.
   */
  onDeleted: () => void;
};

type Preflight = {
  recipients: {
    total: number;
    excluded: number;
    breakdown: Record<string, number>;
    samples: Record<string, { personId: string | null; phone: string | null }[]>;
  };
  cost: { estimatedUsd: number; ratePerMessageUsd: number; note: string };
  tier: {
    tier: string;
    limit: number;
    used: number;
    reserve: number;
    available: number;
    /** `days: Infinity` serialises as null — a campaign that cannot start today. */
    spread: { firstDay: number; days: number | null };
  } | null;
  quality: { rating: string; gate: { allowed: boolean; reason?: string } };
  template: { name: string | null; language: string | null; category: string | null; refusal: string | null } | null;
  preview: { rendered: { header: string | null; body: string; footer: string | null } }[];
};

const COUNTERS = [
  'recipientCount',
  'queuedCount',
  'sentCount',
  'deliveredCount',
  'readCount',
  'respondedCount',
  'failedCount',
  'skippedCount',
  'excludedCount',
] as const;

export const CampaignDetail = ({
  campaign,
  recipients,
  canManage,
  canEdit = true,
  t,
  lang,
  now,
  onBack,
  onChanged,
  onEdit,
  onDeleted,
}: CampaignDetailProps) => {
  const theme = useTheme();
  const { call } = useCampaignActions();

  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [preflightAttempt, setPreflightAttempt] = useState(0);
  const acting = useRef(false);
  const confirming = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledgeQuality, setAcknowledgeQuality] = useState(false);

  const campaignId = campaign.id as string;
  const status = (campaign.status ?? null) as string | null;

  const preflightRevision = status === 'READY' || status === 'DRAFT' ? campaign.updatedAt : status;
  useEffect(() => {
    let active = true;
    setPreflight(null);
    setPreflightError(null);
    setAcknowledgeQuality(false);
    void call<Preflight>('preflight', { campaignId }).then((result) => {
      if (!active) return;
      if (result.ok) setPreflight(result.data);
      else setPreflightError(result.error);
    });
    return () => { active = false; };
  }, [call, campaignId, preflightRevision, preflightAttempt]);

  const run = useCallback(
    async (action: Parameters<typeof call>[0], body: Record<string, unknown> = {}) => {
      if (acting.current) return;
      acting.current = true;
      setBusy(true);
      setError(null);

      const result = await call(action, { campaignId, ...body });

      acting.current = false;
      setBusy(false);

      if (!result.ok) setError(result.error);
      else onChanged();
    },
    [call, campaignId, onChanged],
  );

  /**
   * The host's modal, not a `window.confirm`: a browser dialog blocks the
   * worker's whole message channel, and the extension never gets another
   * command until someone dismisses it by hand.
   */
  const confirmThen = useCallback(
    async (
      title: string,
      subtitle: string,
      action: Parameters<typeof call>[0],
      accent: 'default' | 'danger' = 'default',
    ) => {
      if (confirming.current || acting.current) return;
      confirming.current = true;
      setBusy(true);
      try {
      const answer = await openCommandConfirmationModal({
        title,
        subtitle,
        confirmButtonText: title,
        confirmButtonAccent: accent,
      });

      // Anything that is not an explicit confirmation is a refusal, including a
      // dialog the host closed for its own reasons.
      if (answer === 'confirm') await run(action);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : t('error.unknown'));
      } finally {
        confirming.current = false;
        setBusy(false);
      }
    },
    [run, t],
  );

  /**
   * Deletion, which cannot go through `run`: on success there is no campaign
   * left to re-read, so it hands the screen back to the list instead of asking
   * the feed for a record that no longer exists.
   *
   * The button that calls this only exists for a campaign that never launched
   * (`canDeleteCampaign` below), and the route re-checks the same rule — so a
   * campaign that finished sending between the render and the click is refused
   * server-side rather than deleted by a stale screen.
   */
  const remove = useCallback(async () => {
    if (confirming.current || acting.current) return;
    confirming.current = true;
    setBusy(true);
    setError(null);
    try {
      const answer = await openCommandConfirmationModal({
        title: t('campaign.delete'), subtitle: t('campaign.deleteSubtitle'),
        confirmButtonText: t('campaign.delete'), confirmButtonAccent: 'danger',
      });
      if (answer !== 'confirm') return;
      const result = await call('delete', { campaignId });
      if (!result.ok) setError(result.error);
      else onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error.unknown'));
    } finally {
      confirming.current = false;
      setBusy(false);
    }
  }, [call, campaignId, onDeleted, t]);

  const deletion = canDeleteCampaign(campaign);
  const archived = isArchivedCampaign(campaign);
  const archivable = canArchiveCampaign(campaign);

  const label = { fontSize: theme.font.size.xs, color: theme.font.color.secondary };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[2] }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[2],
          flexWrap: 'wrap',
        }}
      >
        <ActionButton label={t('campaign.title')} icon="back" disabled={busy} onClick={onBack} />
        <span
          style={{
            fontWeight: theme.font.weight.semiBold,
            fontSize: theme.font.size.md,
            color: theme.font.color.primary,
          }}
        >
          {campaign.name ?? '—'}
        </span>
        <StatusPill status={status} t={t} />
        {RUNNING_STATUSES.has(String(status)) ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.spacing[1],
              fontSize: theme.font.size.xs,
              color: theme.font.color.secondary,
            }}
          >
            <Glyph name="running" />
            {/*
              Every recipient attempted, status not yet reconciled: `Running`
              over finished numbers read as stuck, and the reviewer flagged it.
            */}
            {isFinishing(campaign) ? `${t('campaign.finishing')} · ` : null}
            {t('campaign.updated', {
              when: relativeTime(
                (campaign.updatedAt ?? campaign.createdAt ?? null) as string | null,
                now,
                lang,
              ),
            })}
          </span>
        ) : null}
        <span style={{ flex: '1 1 auto' }} />

        {/*
          Launch is gated on the preflight having *arrived*, not merely on the
          status being READY. Without that the confirmation offers "0
          recipients, $0.00" — numbers that belong to no campaign — and the
          operator confirms a send whose size they were never shown.

          A refused quality gate removes this button entirely rather than
          disabling it: there is a deliberate path for that case further down,
          behind an acknowledgement, and two ways to do the same dangerous thing
          is one too many.

          An empty audience removes it too. The route already answers 409 for a
          campaign with no qualified recipient — but the button was offered
          anyway, so a campaign whose only contact had been excluded for missing
          consent invited an operator to confirm sending to nobody and then
          refused. The banner below says which it is (D-60).
        */}
        {canManage &&
        status === 'READY' &&
        preflight !== null &&
        preflight.recipients.total > 0 &&
        preflight.quality.gate.allowed ? (
          <ActionButton
            label={t('campaign.launch')}
            tone="primary"
            icon="running"
            busy={busy}
            onClick={() =>
              void confirmThen(
                t('campaign.launch'),
                t('campaign.launchSubtitle', {
                  count: preflight.recipients.total,
                  cost: money(preflight.cost.estimatedUsd),
                }),
                'launch',
              )
            }
          />
        ) : null}
        {/*
          Back into the builder, for a campaign that has not sent anything
          (D-61). A draft was previously a dead end: readable, deletable, and
          impossible to finish — so an interrupted campaign meant starting over.

          `READY` is offered too because the server already models the
          consequence: editing a snapshot-defining field returns the campaign to
          `draft` and forces a rebuild, so the frozen recipient rows can never
          be launched against a template they were not resolved for (D-28).
        */}
        {canManage && (status === 'DRAFT' || status === 'READY') ? (
          <ActionButton label={t('campaign.edit')} icon="edit" disabled={busy || !canEdit} onClick={onEdit} />
        ) : null}
        {canManage && (status === 'RUNNING' || status === 'TIER_WAITING') ? (
          <ActionButton
            label={t('campaign.pause')}
            icon="paused"
            busy={busy}
            onClick={() =>
              void confirmThen(t('campaign.pause'), String(campaign.name ?? ''), 'pause')
            }
          />
        ) : null}
        {canManage && status === 'PAUSED' ? (
          <ActionButton
            label={t('campaign.resume')}
            icon="running"
            busy={busy}
            onClick={() =>
              void confirmThen(t('campaign.resume'), String(campaign.name ?? ''), 'resume')
            }
          />
        ) : null}
        {canManage &&
        status !== 'COMPLETED' &&
        status !== 'CANCELLED' &&
        status !== 'FAILED' ? (
          <ActionButton
            label={t('campaign.cancel')}
            tone="danger"
            icon="dismiss"
            busy={busy}
            onClick={() =>
              void confirmThen(
                t('campaign.cancel'),
                t('campaign.cancelSubtitle'),
                'cancel',
                'danger',
              )
            }
          />
        ) : null}

        {/*
          Archiving and its undo, in the same place, with no confirmation modal.

          Deliberately unguarded: it hides nothing that cannot be shown again in
          one click, and a dialog in front of a tidy-up is what makes an operator
          leave forty finished campaigns on the page rather than file them. The
          destructive controls above keep their modals — those are the ones that
          cannot be taken back.
        */}
        {canManage && archived ? (
          <ActionButton
            label={t('campaign.unarchive')}
            icon="unarchive"
            busy={busy}
            onClick={() => void run('unarchive')}
          />
        ) : null}
        {canManage && !archived && archivable.ok ? (
          <ActionButton
            label={t('campaign.archive')}
            icon="archive"
            busy={busy}
            onClick={() => void run('archive')}
          />
        ) : null}
      </div>

      {error === null ? null : <Banner tone="danger">{error}</Banner>}
      {preflightError === null ? null : (
        <Banner tone="danger">
          {preflightError}
          <ActionButton label={t('common.retry')} icon="retry" onClick={() => setPreflightAttempt((attempt) => attempt + 1)} />
        </Banner>
      )}

      {/*
        Said on the record itself, not only in the list it is missing from: this
        screen is reachable from a link, a search or a back button, and a
        campaign that is quietly absent from the campaigns page is one somebody
        will report as deleted.
      */}
      {archived ? (
        <Banner>
          {t('campaign.archivedOn', {
            when: relativeTime(campaign.archivedAt as string | null, now, lang),
          })}
        </Banner>
      ) : null}

      {canManage && status === 'READY' && preflight === null && preflightError === null ? (
        <Banner>{t('campaign.launchNeedsPreflight')}</Banner>
      ) : null}

      {/*
        Why there is no Launch button. A campaign whose every contact was
        excluded looked ready, and the only way to discover otherwise was to
        press Launch and read a 409 (D-60).
      */}
      {canManage && status === 'READY' && preflight !== null && preflight.recipients.total === 0 ? (
        <Banner tone="danger">
          {t('campaign.launchNoRecipients', { excluded: preflight.recipients.excluded })}
        </Banner>
      ) : null}

      {campaign.statusReason === null || campaign.statusReason === undefined ? null : (
        <Banner>
          {t('campaign.reason')}: {String(campaign.statusReason)}
        </Banner>
      )}

      {campaign.pacingObserved === true ? (
        <Banner>{t('campaign.pacing')}</Banner>
      ) : null}

      <Card title={t('campaign.numbers')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: theme.spacing[4] }}>
          {COUNTERS.map((key) => (
            <div key={key} style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={label}>{t(`campaign.counter.${key}`)}</span>
              <span style={{ fontSize: theme.font.size.lg, color: theme.font.color.primary }}>
                {Number(campaign[key] ?? 0)}
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={label}>{t('campaign.counter.actualCost')}</span>
            <span style={{ fontSize: theme.font.size.lg, color: theme.font.color.primary }}>
              {money(Number(campaign.actualCostUsd ?? 0))}
            </span>
          </div>
        </div>
      </Card>

      {/*
        The same nine numbers as a shape. The grid above answers "how many
        read it"; this answers "how many of the people we sent to" — which is
        the question anyone asks second, and which nine equal figures in a row
        make you do arithmetic for.

        Only once there is an audience to be a share of: five empty bars under
        a draft say nothing a zero does not.
      */}
      {Number(campaign.recipientCount ?? 0) === 0 ? null : (
        <Card title={t('campaign.funnel')}>
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}
          >
            {deliveryFunnel(campaign).map((stage) => (
              <div
                key={stage.key}
                style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[2] }}
              >
                <span
                  style={{
                    flex: '0 0 120px',
                    fontSize: theme.font.size.sm,
                    color: theme.font.color.secondary,
                  }}
                >
                  {t(stage.key)}
                </span>
                {/*
                  `role="img"` with the numbers in the label: the bar is a
                  picture of a figure that is already on the row, so a screen
                  reader gets the sentence and not a stray graphic.
                */}
                <span
                  role="img"
                  aria-label={`${t(stage.key)}: ${stage.value}`}
                  style={{
                    flex: '1 1 auto',
                    height: '8px',
                    borderRadius: theme.border.radius.pill,
                    background: theme.background.transparent.light,
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      width: `${Math.round(stage.share * 100)}%`,
                      height: '100%',
                      background: theme.color.blue,
                    }}
                  />
                </span>
                <span
                  style={{
                    flex: '0 0 auto',
                    fontSize: theme.font.size.sm,
                    color: theme.font.color.primary,
                    minWidth: '48px',
                    textAlign: 'right',
                  }}
                >
                  {stage.value}
                </span>
              </div>
            ))}
          </div>
          <span style={label}>{t('campaign.funnelNote')}</span>
        </Card>
      )}

      {preflight === null ? null : (
        <>
          <Card title={t('campaign.preflightAudience')}>
            <div style={{ display: 'flex', gap: theme.spacing[4], flexWrap: 'wrap' }}>
              <div>
                <span style={label}>{t('campaign.willReceive')}</span>
                <div style={{ fontSize: theme.font.size.lg }}>
                  {preflight.recipients.total}
                </div>
              </div>
              <div>
                <span style={label}>{t('campaign.excluded')}</span>
                <div style={{ fontSize: theme.font.size.lg }}>
                  {preflight.recipients.excluded}
                </div>
              </div>
            </div>

            {Object.entries(preflight.recipients.breakdown)
              .filter(([, count]) => count > 0)
              .map(([reason, count]) => (
                <div key={reason} style={{ fontSize: theme.font.size.xs }}>
                  <span style={{ color: theme.font.color.secondary }}>
                    {t(`exclusion.${reason}`)}: {count}
                  </span>
                  <span style={{ ...label, marginLeft: theme.spacing[2] }}>
                    {(preflight.recipients.samples[reason] ?? [])
                      .slice(0, 3)
                      .map((sample) => sample.phone ?? sample.personId ?? '?')
                      .join(', ')}
                  </span>
                </div>
              ))}
          </Card>

          <Card title={t('campaign.preflightCost')}>
            <div style={{ fontSize: theme.font.size.sm }}>
              {t('campaign.perMessage', {
                total: money(preflight.cost.estimatedUsd),
                rate: money(preflight.cost.ratePerMessageUsd),
              })}
            </div>
            <div style={label}>{preflight.cost.note}</div>

            {preflight.tier === null ? null : (
              <div style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
                {t('campaign.tierLine', {
                  tier: preflight.tier.tier,
                  used: preflight.tier.used,
                  limit: preflight.tier.limit,
                  reserve: preflight.tier.reserve,
                  available: preflight.tier.available,
                })}
              </div>
            )}

            {/*
              The spread is the number that turns "your audience is bigger than
              your daily allowance" from a surprise two days in into a sentence
              read before launch (R-10).
            */}
            {preflight.tier === null || preflight.tier.spread.days === null ? null : (
              <div style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
                {preflight.tier.spread.days <= 1
                  ? t('campaign.spreadFits')
                  : t('campaign.spreadDays', {
                      firstDay: preflight.tier.spread.firstDay,
                      days: preflight.tier.spread.days,
                    })}
              </div>
            )}
          </Card>

          <Card title={t('campaign.preflightQuality')}>
            <div style={{ fontSize: theme.font.size.xs }}>
              {t('campaign.quality')}: {preflight.quality.rating}
              {preflight.quality.gate.allowed ? '' : ` — ${preflight.quality.gate.reason ?? ''}`}
            </div>

            {preflight.quality.gate.allowed || !canManage ? null : (
              <label
                style={{
                  display: 'flex',
                  gap: theme.spacing[1],
                  fontSize: theme.font.size.xs,
                  color: theme.font.color.secondary,
                }}
              >
                <input
                  type="checkbox"
                  checked={acknowledgeQuality}
                  onChange={(event) => setAcknowledgeQuality(event.target.checked)}
                />
                {t('campaign.acknowledge')}
              </label>
            )}

            {/*
              "Launch anyway" overrides the *quality* gate and nothing else. An
              empty audience is not a risk an admin can accept — there is no
              send to accept the risk of — so it withdraws this button too
              (D-60).
            */}
            {acknowledgeQuality && status === 'READY' && preflight.recipients.total > 0 ? (
              <ActionButton
                label={t('campaign.launchAnyway')}
                tone="danger"
                busy={busy}
                onClick={() => void run('launch', { acknowledgeQuality: true })}
              />
            ) : null}

            {preflight.template === null ? null : (
              <div style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
                {preflight.template.name} ({preflight.template.language}) ·{' '}
                {preflight.template.category}
                {preflight.template.refusal === null
                  ? ''
                  : ` — ${preflight.template.refusal}`}
              </div>
            )}
          </Card>

          {preflight.preview.length === 0 ? null : (
            <Card title={t('campaign.preflightPreview')}>
              <div
                style={{
                  border: `1px dashed ${theme.border.color.medium}`,
                  borderRadius: theme.border.radius.sm,
                  padding: theme.spacing[2],
                  fontSize: theme.font.size.sm,
                  whiteSpace: 'pre-wrap',
                  color: theme.font.color.secondary,
                }}
              >
                {preflight.preview[0].rendered.header === null ? null : (
                  <div style={{ fontWeight: theme.font.weight.semiBold }}>
                    {preflight.preview[0].rendered.header}
                  </div>
                )}
                <div>{preflight.preview[0].rendered.body}</div>
                {preflight.preview[0].rendered.footer === null ? null : (
                  <div style={label}>{preflight.preview[0].rendered.footer}</div>
                )}
              </div>
            </Card>
          )}

          {canManage && status === 'READY' ? (
            <ActionButton
              label={t('campaign.testSend')}
              icon="testAccount"
              busy={busy}
              onClick={() => void run('testSend')}
            />
          ) : null}
        </>
      )}

      <Card title={t('campaign.recipientsSample', { count: recipients.length })}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: theme.font.size.xs, width: '100%' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: theme.font.color.secondary }}>
                <th style={{ padding: theme.spacing[1] }}>{t('campaign.col.phone')}</th>
                <th style={{ padding: theme.spacing[1] }}>{t('campaign.col.status')}</th>
                <th style={{ padding: theme.spacing[1] }}>{t('campaign.col.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((recipient) => (
                <tr key={String(recipient.id)}>
                  <td
                    style={{
                      padding: theme.spacing[1],
                      borderTop: `1px solid ${theme.border.color.light}`,
                    }}
                  >
                    {recipient.resolvedPhone ?? '—'}
                  </td>
                  <td
                    style={{
                      padding: theme.spacing[1],
                      borderTop: `1px solid ${theme.border.color.light}`,
                    }}
                  >
                    {recipient.status ?? '—'}
                  </td>
                  <td
                    style={{
                      padding: theme.spacing[1],
                      borderTop: `1px solid ${theme.border.color.light}`,
                      color: theme.font.color.secondary,
                    }}
                  >
                    {recipient.exclusionReason === null ||
                    recipient.exclusionReason === undefined
                      ? (recipient.errorCode ?? '')
                      : t(`exclusion.${String(recipient.exclusionReason)}`)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/*
        Deletion, last on the screen and only while it is legitimate.

        A campaign that has sent something shows nothing here at all: there is
        no disabled button and no explanation of a rule that cannot be broken,
        because the honest answer to "how do I delete this" is that the record
        of a bulk send to real people stays. Cancel is the control for that, and
        it is at the top of the screen where the live campaigns' controls are.

        What the note does say — while the campaign is still deletable — is that
        launching ends this option, which is the one moment the rule is worth a
        sentence.
      */}
      {canManage && deletion.ok ? (
        <Card title={t('campaign.delete')}>
          <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}>
            {t('campaign.deleteNote')}
          </span>
          <div style={{ display: 'flex' }}>
            <ActionButton
              label={t('campaign.delete')}
              tone="danger"
              icon="remove"
              busy={busy}
              onClick={() => void remove()}
            />
          </div>
        </Card>
      ) : null}
    </div>
  );
};
