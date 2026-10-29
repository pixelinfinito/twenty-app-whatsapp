import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import { useCopy, type Lang, type Translate } from '../common/copy';
import { displayPhone, money, relativeTime } from '../common/format';
import { Glyph } from '../common/icons';
import { ActionButton, Banner, Card, EmptyState, StatusPill } from '../common/ui';
import { useFeed } from '../common/use-feed';
import { CampaignBuilder } from './CampaignBuilder';
import { CampaignDetail } from './CampaignDetail';
import {
  CAMPAIGN_FILTERS,
  RUNNING_STATUSES,
  audienceSummary,
  isArchiveFilter,
  isAutosavedDraft,
  isFinishing,
  visibleCampaigns,
  type CampaignFilter,
} from './list';

/**
 * The campaigns page (FR-CAM-10, specs/08 §5).
 *
 * Three screens behind one feed: the list, the builder, and one campaign's
 * detail. They share a poll rather than each opening their own, and the
 * interval tightens only while something is actually running — a page of
 * finished campaigns asking every ten seconds whether they are still finished
 * is exactly the budget D-6 exists to protect.
 */

/**
 * Below this the nine-column table cannot hold real names and counts without
 * colliding, so the list switches to stacked cards. Measured the same way the
 * inbox used to: `clientWidth` re-read every render, because `ResizeObserver`
 * is undefined here and `getBoundingClientRect` returns 0×0 (P-6).
 *
 * The inbox has since moved to a container query, which is the better answer
 * and would suit this too. It is not converted here because the table/card
 * switch changes *what is rendered* — nine columns or three lines, not one
 * layout reflowed — and rendering both so CSS can hide one would double the
 * rows in the accessibility tree for every campaign in the workspace.
 */
export const TABLE_MIN_WIDTH = 640;

export const CampaignsView = () => {
  const theme = useTheme();
  const { t, lang } = useCopy();

  const [screen, setScreen] = useState<'list' | 'builder'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * The campaign the builder is reopening, if it is reopening one (D-61).
   *
   * Held here rather than fetched by the builder: the detail screen already has
   * the record polled and in hand, and a second read would race the write the
   * builder is about to make.
   */
  const [editing, setEditing] = useState<Record<string, any> | null>(null);
  const [wide, setWide] = useState(true);
  const [filter, setFilter] = useState<CampaignFilter>('all');
  const [search, setSearch] = useState('');

  const measured = useRef<boolean | null>(null);
  const node = useRef<HTMLDivElement | null>(null);

  const measure = useCallback(() => {
    const element = node.current;

    if (element === null) return;

    try {
      const width =
        element.clientWidth > 0
          ? element.clientWidth
          : typeof window === 'undefined'
            ? 0
            : (window.innerWidth ?? 0);

      const isWide = width >= TABLE_MIN_WIDTH;

      if (measured.current !== isWide) {
        measured.current = isWide;
        setWide(isWide);
      }
    } catch {
      // Failing towards the card layout is the safe direction: cards in a
      // wide pane are merely roomy, the table in a narrow one is unreadable.
      measured.current = false;
      setWide(false);
    }
  }, []);

  useEffect(() => {
    measure();
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }

    try {
      window.addEventListener('resize', measure);

      return () => window.removeEventListener('resize', measure);
    } catch {
      return;
    }
  }, [measure]);

  const archiveOpen = isArchiveFilter(filter);

  /**
   * One feed, two lists. `archived` changes what the server sends rather than
   * what this component keeps, and the hook treats it as a change of subject —
   * so switching to the archive clears the live rows instead of showing them
   * under it for one interval.
   *
   * The archive polls on a slower clock: nothing in it is moving, by definition.
   * Ten seconds is the interval for a page that might have a campaign sending on
   * it, and paying that every ten seconds to re-read forty finished campaigns is
   * exactly the cost D-6 exists to control.
   */
  const list = useFeed({
    scope: 'campaign',
    archived: archiveOpen,
    intervalMs: archiveOpen ? 60_000 : 10_000,
  });
  const detail = useFeed({
    scope: 'campaign',
    id: selectedId,
    enabled: selectedId !== null,
    intervalMs: 5_000,
  });

  const bootstrap = useFeed({ scope: 'bootstrap', intervalMs: 300_000 });

  const campaigns = (list.data?.campaigns ?? []) as Record<string, any>[];
  const canManage = list.data?.permissions.canManageCampaigns === true;
  const now = new Date(list.data?.serverTime ?? Date.now());

  const anyRunning = useMemo(
    () => campaigns.some((campaign) => RUNNING_STATUSES.has(String(campaign.status))),
    [campaigns],
  );

  /**
   * The sending number per row. The bootstrap feed already carries the
   * accounts for the builder; the list borrows them rather than paying a
   * second read.
   */
  const numberByAccount = useMemo(
    () =>
      new Map(
        (bootstrap.data?.accounts ?? []).map((account) => [
          account.id,
          account.displayPhoneNumber ?? null,
        ]),
      ),
    [bootstrap.data],
  );

  const visible = useMemo(
    () => visibleCampaigns(campaigns, filter, search),
    [campaigns, filter, search],
  );

  if (screen === 'builder') {
    return (
      <div
        {...list.rootProps}
        style={{
          padding: theme.spacing[3],
          overflowY: 'auto',
          height: '100%',
          background: theme.background.primary,
          color: theme.font.color.primary,
          fontFamily: theme.font.family,
        }}
      >
        <CampaignBuilder
          accounts={bootstrap.data?.accounts ?? []}
          templates={bootstrap.data?.templates ?? []}
          resume={editing}
          onCancel={() => {
            setScreen('list');
            setEditing(null);
          }}
          onDone={(campaignId) => {
            setSelectedId(campaignId);
            setScreen('list');
            setEditing(null);
            list.refresh();
          }}
        />
      </div>
    );
  }

  if (selectedId !== null) {
    const campaign = (detail.data?.campaign ?? null) as Record<string, any> | null;

    return (
      <div
        {...detail.rootProps}
        style={{
          padding: theme.spacing[3],
          overflowY: 'auto',
          height: '100%',
          background: theme.background.primary,
          color: theme.font.color.primary,
          fontFamily: theme.font.family,
        }}
      >
        {campaign === null ? (
          <Banner>{t('common.loading')}</Banner>
        ) : (
          <CampaignDetail
            campaign={campaign}
            recipients={(detail.data?.recipients ?? []) as Record<string, any>[]}
            canManage={canManage}
            t={t}
            lang={lang}
            now={new Date(detail.data?.serverTime ?? Date.now())}
            onBack={() => setSelectedId(null)}
            onChanged={() => {
              detail.refresh();
              list.refresh();
            }}
            /**
             * Into the builder with the record this screen is already showing.
             * The detail screen closes: the builder writes on every step, so
             * leaving a stale copy of the campaign behind it would be a second
             * source of truth for the same rows (D-61).
             */
            onEdit={() => {
              setEditing(campaign);
              setSelectedId(null);
              setScreen('builder');
            }}
            /**
             * Back to the list, and refresh it — the deleted campaign is still
             * in the last poll's `campaigns` array, so without the refresh the
             * operator returns to a list that still shows what they just
             * deleted and re-opens a 404.
             */
            onDeleted={() => {
              setSelectedId(null);
              list.refresh();
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div
      ref={node}
      {...list.rootProps}
      style={{
        padding: theme.spacing[3],
        overflowY: 'auto',
        height: '100%',
        background: theme.background.primary,
        color: theme.font.color.primary,
        fontFamily: theme.font.family,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[2] }}>
        <span
          style={{ fontWeight: theme.font.weight.semiBold, fontSize: theme.font.size.lg }}
        >
          {t('campaign.title')}
        </span>
        {/*
          The heading says which of the two lists this is. Without it the archive
          is a page of campaigns that look like the live ones and are not on the
          live page — which is the moment somebody concludes a campaign has been
          deleted.
        */}
        {archiveOpen ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.spacing[1],
              fontSize: theme.font.size.sm,
              color: theme.font.color.tertiary,
            }}
          >
            <Glyph name="archive" />
            {t('campaign.archiveTitle')}
          </span>
        ) : null}
        <span style={{ flex: '1 1 auto' }} />
        {/*
          No "New campaign" while the archive is open: the button would create a
          draft that appears on the page the operator is not looking at.
        */}
        {canManage && !archiveOpen ? (
          <ActionButton
            label={t('campaign.new')}
            tone="primary"
            icon="newCampaign"
            onClick={() => {
              setEditing(null);
              setScreen('builder');
            }}
          />
        ) : null}
      </div>

      {list.isStale ? <Banner tone="danger">{t('chat.offline')}</Banner> : null}

      {/* Nothing loaded at all is a different thing from no campaigns yet. */}
      {list.isUnavailable ? (
        <Banner tone="danger">
          {t('common.unavailable')} {list.error}
        </Banner>
      ) : null}

      {anyRunning ? <Banner>{t('campaign.running')}</Banner> : null}

      {/*
        The toolbar appears only once there is something to navigate. A search
        box above "Ainda não há campanhas." is furniture.

        The exception is a filter that is already narrowing something — most of
        all `archived`, which asks the server for a *different* list: an empty
        archive with no chips is a screen with no way back to the campaigns,
        which is precisely the hidden-state-with-no-exit this filter was added to
        avoid.
      */}
      {campaigns.length === 0 && filter === 'all' ? null : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing[2],
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: theme.spacing[1],
              border: `1px solid ${theme.border.color.medium}`,
              borderRadius: theme.border.radius.sm,
              background: theme.background.primary,
              padding: `0 ${theme.spacing[2]}`,
              minHeight: '32px',
              flex: '1 1 220px',
              maxWidth: '320px',
            }}
          >
            <Glyph name="search" />
            <input
              type="search"
              value={search}
              placeholder={t('campaign.search')}
              aria-label={t('campaign.search')}
              onChange={(event) => setSearch(event.target.value)}
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: theme.font.color.primary,
                fontFamily: theme.font.family,
                fontSize: theme.font.size.md,
                padding: `${theme.spacing[1]} 0`,
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: theme.spacing[1], flexWrap: 'wrap' }}>
            {CAMPAIGN_FILTERS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                aria-pressed={filter === key}
                style={{
                  minHeight: '28px',
                  border: `1px solid ${
                    filter === key ? theme.border.color.strong : theme.border.color.light
                  }`,
                  borderRadius: theme.border.radius.pill,
                  background:
                    filter === key ? theme.background.transparent.light : 'transparent',
                  color:
                    filter === key ? theme.font.color.primary : theme.font.color.secondary,
                  cursor: 'pointer',
                  fontFamily: theme.font.family,
                  fontSize: theme.font.size.sm,
                  fontWeight:
                    filter === key ? theme.font.weight.medium : theme.font.weight.regular,
                  padding: `0 ${theme.spacing[2]}`,
                  whiteSpace: 'nowrap',
                }}
              >
                {t(`campaign.filter.${key}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      {campaigns.length === 0 ? (
        <Card>
          {list.isUnavailable ? (
            <EmptyState icon="warning" title={t('common.unavailable')} />
          ) : list.isLoading && list.data === null ? (
            <div
              style={{
                padding: theme.spacing[4],
                textAlign: 'center',
                color: theme.font.color.tertiary,
                fontSize: theme.font.size.md,
              }}
            >
              {t('common.loading')}
            </div>
          ) : archiveOpen ? (
            /*
              An empty archive is not "no campaigns yet", and offering to create
              one here would answer a question nobody asked. It offers the way
              back instead — the only thing anyone wants from an empty archive.
            */
            <EmptyState
              icon="archive"
              title={t('campaign.archiveNone')}
              body={t('campaign.archiveNoneBody')}
              actions={
                <ActionButton
                  label={t('campaign.archiveBack')}
                  icon="back"
                  onClick={() => setFilter('all')}
                />
              }
            />
          ) : (
            <EmptyState
              icon="newCampaign"
              title={t('campaign.none')}
              body={t('campaign.noneBody')}
              /*
                The archive link is here as well as in the chips, because this is
                the one state where the chips are hidden — and "every campaign we
                have is archived" is precisely a state that produces an empty
                live list. Without it, archiving the last campaign would hide the
                archive along with it.
              */
              actions={
                <>
                  {canManage ? (
                    <ActionButton
                      label={t('campaign.new')}
                      tone="primary"
                      icon="newCampaign"
                      onClick={() => {
                        setEditing(null);
                        setScreen('builder');
                      }}
                    />
                  ) : null}
                  <ActionButton
                    label={t('campaign.filter.archived')}
                    icon="archive"
                    onClick={() => setFilter('archived')}
                  />
                </>
              }
            />
          )}
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            icon="search"
            title={t('campaign.noMatches')}
            actions={
              <ActionButton
                label={t('common.clear')}
                icon="dismiss"
                onClick={() => {
                  setSearch('');
                  setFilter('all');
                }}
              />
            }
          />
        </Card>
      ) : wide ? (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                borderCollapse: 'collapse',
                width: '100%',
                /**
                 * Fit is never solved by shrinking text: below this the whole
                 * list switches to cards, so the table only ever renders with
                 * room for real names and counts.
                 */
                minWidth: `${TABLE_MIN_WIDTH}px`,
                fontSize: theme.font.size.md,
              }}
            >
              <thead>
                <tr style={{ textAlign: 'left', color: theme.font.color.tertiary }}>
                  {[
                    'campaign.col.name',
                    'campaign.col.status',
                    'campaign.counter.recipientCount',
                    'campaign.counter.deliveredCount',
                    'campaign.counter.readCount',
                    'campaign.counter.failedCount',
                    'campaign.counter.respondedCount',
                    'campaign.counter.actualCost',
                    // In the archive, the date that matters is when it was filed
                    // — which is also the order the rows arrive in.
                    archiveOpen ? 'campaign.col.archived' : 'campaign.col.created',
                  ].map((key) => (
                    <th
                      key={key}
                      style={{
                        padding: theme.spacing[2],
                        fontSize: theme.font.size.sm,
                        fontWeight: theme.font.weight.medium,
                      }}
                    >
                      {t(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((campaign) => (
                  <CampaignRow
                    key={String(campaign.id)}
                    campaign={campaign}
                    now={now}
                    lang={lang}
                    t={t}
                    archived={archiveOpen}
                    phone={numberByAccount.get(String(campaign.accountId ?? '')) ?? null}
                    onOpen={() => setSelectedId(String(campaign.id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        /**
         * The narrow shape: one card per campaign, the whole card a button
         * into detail. Name, status, and the counters that matter; the rest
         * lives in the detail screen it opens.
         */
        visible.map((campaign) => (
          <button
            key={String(campaign.id)}
            type="button"
            onClick={() => setSelectedId(String(campaign.id))}
            aria-label={`${t('campaign.open')}: ${String(campaign.name ?? '')}`}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: theme.spacing[1],
              width: '100%',
              textAlign: 'left',
              border: `1px solid ${theme.border.color.light}`,
              borderRadius: theme.border.radius.md,
              background: theme.background.secondary,
              color: theme.font.color.primary,
              cursor: 'pointer',
              fontFamily: theme.font.family,
              padding: theme.spacing[3],
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[2] }}>
              <span
                style={{
                  fontSize: theme.font.size.md,
                  fontWeight: theme.font.weight.semiBold,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: '1 1 auto',
                }}
              >
                {String(campaign.name ?? '—')}
              </span>
              <StatusPill status={(campaign.status ?? null) as string | null} t={t} />
              {/*
                The affordance the card was missing: nothing on it said it was
                a button, so the whole row read as a summary card.
              */}
              <Glyph name="chevron" />
            </span>

            <AudienceLine
              campaign={campaign}
              phone={numberByAccount.get(String(campaign.accountId ?? '')) ?? null}
              t={t}
            />

            <span
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: theme.spacing[3],
                fontSize: theme.font.size.sm,
                color: theme.font.color.secondary,
              }}
            >
              <Metric
                icon="audience"
                label={t('campaign.counter.deliveredCount')}
                value={`${Number(campaign.deliveredCount ?? 0)}/${Number(campaign.recipientCount ?? 0)}`}
              />
              <Metric
                icon="replies"
                label={t('campaign.counter.respondedCount')}
                value={String(Number(campaign.respondedCount ?? 0))}
              />
              <Metric
                icon="cost"
                label={t('campaign.counter.actualCost')}
                value={money(Number(campaign.actualCostUsd ?? campaign.estimatedCostUsd ?? 0))}
              />
            </span>

            <Freshness campaign={campaign} now={now} lang={lang} t={t} />
          </button>
        ))
      )}
    </div>
  );
};

/**
 * Who the campaign targets and which number sends it, as one quiet line.
 *
 * The list said nothing about either, so two campaigns sharing a name — one a
 * leftover autosaved draft — could only be told apart by opening both. The
 * draft label rides on the same line: work the builder saved automatically is
 * labelled as exactly that, rather than posing as a finished campaign.
 */
const AudienceLine = ({
  campaign,
  phone,
  t,
}: {
  campaign: Record<string, any>;
  phone: string | null;
  t: Translate;
}) => {
  const theme = useTheme();
  const audience = audienceSummary(campaign);

  const parts = [
    isAutosavedDraft(campaign) ? t('campaign.autosavedDraft') : null,
    audience === null
      ? null
      : audience.kind === 'view'
        ? t('campaign.audienceView')
        : t('campaign.audienceManual', { count: audience.count }),
    phone === null || phone.length === 0 ? null : displayPhone(phone),
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) return null;

  return (
    <span
      style={{
        fontSize: theme.font.size.xs,
        color: theme.font.color.tertiary,
        fontWeight: theme.font.weight.regular,
      }}
    >
      {parts.join(' · ')}
    </span>
  );
};

/**
 * One table row, clickable across its whole width.
 *
 * The name used to be the only target — an underlined button inside the first
 * cell — so eight of the nine columns did nothing when clicked. A `<tr>`
 * cannot be a `<button>`, so the row carries the click and the name cell keeps
 * a real button for the keyboard: `onClick` on a row is a mouse affordance,
 * and a mouse affordance on its own is not an affordance.
 */
const CampaignRow = ({
  campaign,
  now,
  lang,
  t,
  archived = false,
  phone = null,
  onOpen,
}: {
  campaign: Record<string, any>;
  now: Date;
  lang: Lang;
  t: Translate;
  /** Rendering the archive: the last column reads `archivedAt`, not `createdAt`. */
  archived?: boolean;
  /** The sending number's display phone, resolved by the list. */
  phone?: string | null;
  onOpen: () => void;
}) => {
  const theme = useTheme();
  const [hover, setHover] = useState(false);

  const cell: React.CSSProperties = {
    padding: theme.spacing[2],
    borderTop: `1px solid ${theme.border.color.light}`,
  };

  return (
    <tr
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: 'pointer',
        background: hover ? theme.background.transparent.light : 'transparent',
      }}
    >
      <td style={cell}>
        <button
          type="button"
          onClick={(event) => {
            // The row handles it; letting it through would open twice.
            event.stopPropagation();
            onOpen();
          }}
          aria-label={`${t('campaign.open')}: ${String(campaign.name ?? '')}`}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: theme.spacing[0.5],
            minHeight: '28px',
            border: 'none',
            background: 'transparent',
            color: theme.font.color.primary,
            cursor: 'pointer',
            fontFamily: theme.font.family,
            fontSize: theme.font.size.md,
            padding: 0,
            textAlign: 'left',
          }}
        >
          <span style={{ textDecoration: hover ? 'underline' : 'none' }}>
            {String(campaign.name ?? '—')}
          </span>
          <AudienceLine campaign={campaign} phone={phone} t={t} />
          <Freshness campaign={campaign} now={now} lang={lang} t={t} />
        </button>
      </td>
      <td style={cell}>
        <StatusPill status={(campaign.status ?? null) as string | null} t={t} />
      </td>
      {(
        [
          'recipientCount',
          'deliveredCount',
          'readCount',
          'failedCount',
          'respondedCount',
        ] as const
      ).map((key) => (
        <td key={key} style={cell}>
          {Number(campaign[key] ?? 0)}
        </td>
      ))}
      <td style={cell}>
        {money(Number(campaign.actualCostUsd ?? campaign.estimatedCostUsd ?? 0))}
      </td>
      <td style={{ ...cell, color: theme.font.color.tertiary }}>
        {relativeTime(
          (archived ? campaign.archivedAt : campaign.createdAt) as string | null,
          now,
          lang,
        )}
      </td>
    </tr>
  );
};

/**
 * Progress and recency, for a campaign that is moving.
 *
 * Only rendered while something is actually happening. "Actualizado há 4
 * meses" under a completed campaign is noise; under a running one, "12 de 400
 * enviadas · actualizado há 20 s" is the difference between a screen that is
 * live and a screen that might be stuck.
 */
const Freshness = ({
  campaign,
  now,
  lang,
  t,
}: {
  campaign: Record<string, any>;
  now: Date;
  lang: Lang;
  t: Translate;
}) => {
  const theme = useTheme();

  if (!RUNNING_STATUSES.has(String(campaign.status))) return null;

  const total = Number(campaign.recipientCount ?? 0);
  const done = Number(campaign.sentCount ?? 0);
  const updated = (campaign.updatedAt ?? campaign.createdAt ?? null) as string | null;
  /**
   * Everything already attempted, status not yet reconciled: say so instead of
   * a progress line that reads as stuck at 100%.
   */
  const finishing = isFinishing(campaign);

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.spacing[1],
        fontSize: theme.font.size.xs,
        color: theme.font.color.tertiary,
        fontWeight: theme.font.weight.regular,
      }}
    >
      <Glyph name="running" />
      {finishing
        ? `${t('campaign.finishing')} · `
        : total === 0
          ? null
          : `${t('campaign.progress', { done, total })} · `}
      {t('campaign.updated', { when: relativeTime(updated, now, lang) })}
    </span>
  );
};

const Metric = ({
  icon,
  label,
  value,
}: {
  icon: 'audience' | 'replies' | 'cost';
  label: string;
  value: string;
}) => {
  const theme = useTheme();

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: theme.spacing[1] }}
      title={label}
    >
      <Glyph name={icon} label={label} />
      {value}
    </span>
  );
};
