import { useCallback, useMemo, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { ThreadProjection } from '../../domain/feed/projection';
import { useActions } from '../common/actions';
import { useCopy, type Lang, type Translate } from '../common/copy';
import { Glyph, type IconName } from '../common/icons';
import { ActionButton, Banner, EmptyState } from '../common/ui';
import { countdown, displayPhone, relativeTime } from '../common/format';
import { SURFACE_MIN_HEIGHT, SURFACE_PAGE_HEIGHT } from '../common/surface';
import { InboundToaster } from './InboundToaster';
import { filterThreads, nextThreadId, threadName } from './list';
import { useFeed } from '../common/use-feed';
import { ThreadView } from '../chat/ThreadView';

/**
 * The inbox (FR-UI-2, specs/08 §4).
 *
 * **Layout is CSS now, not measurement.** The previous version read
 * `node.clientWidth` on every render and switched panes from React state,
 * because `ResizeObserver` is undefined in this sandbox and
 * `getBoundingClientRect` returns 0×0 (P-6). It worked, at the cost of lagging
 * a resize by up to a poll interval and of a comment explaining why. A
 * container query answers the same question — *how wide is this widget*, not
 * how wide is the browser — with no observer, no state and no lag, because the
 * browser evaluates it. `@container` needs no API the sandbox has taken away.
 *
 * The fallback direction is unchanged and still deliberate: the narrow, single
 * pane layout is the *default*, and two panes are the enhancement inside the
 * query. A renderer that does not understand `@container` therefore gets the
 * layout that works at every width, which is what the old `catch` chose too.
 *
 * **No virtualisation.** Every windowing library measures with the observers
 * that throw here. Fifty rows and a "Carregar mais" is the design that works.
 */

/** Kept exported: it is the layout's one number, and the CSS below reads it. */
export const TWO_PANE_MIN_WIDTH = 720;

/** How often the per-filter totals are re-read. See `FeedQuery.counts`. */
const COUNTS_INTERVAL_MS = 30_000;

/** The seven the feed route accepts; the labels come from the catalog. */
const FILTERS = [
  'mine',
  'unassigned',
  'all',
  'unread',
  'campaign_replies',
  'window_expiring',
  'closed',
] as const;

type Filter = (typeof FILTERS)[number];

/**
 * The four a rep works out of, and the three they go looking for.
 *
 * Seven equal chips in one scrolling strip made the most-used filters
 * indistinguishable from the least-used, and on a narrow widget the last
 * of them was off-screen entirely with nothing to say so. The split is what
 * "More filters" means. `unread` is primary: "what have I not seen" is the
 * question an inbox exists to answer.
 */
const PRIMARY: Filter[] = ['mine', 'unassigned', 'all', 'unread'];

const FILTER_ICON: Record<Filter, IconName> = {
  mine: 'mine',
  unassigned: 'unassigned',
  all: 'all',
  unread: 'unread',
  campaign_replies: 'campaign_replies',
  window_expiring: 'window_expiring',
  closed: 'closed',
};

const ThreadRow = ({
  thread,
  selected,
  onSelect,
  now,
  lang,
  t,
  viewerId,
}: {
  thread: ThreadProjection;
  selected: boolean;
  onSelect: () => void;
  now: Date;
  lang: Lang;
  t: Translate;
  viewerId: string | null;
}) => {
  const theme = useTheme();
  const remaining = countdown(thread.serviceWindowExpiresAt, now);
  const name = threadName(thread);
  const mine = viewerId !== null && thread.assigneeId === viewerId;

  const badge: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing[0.5],
    fontSize: theme.font.size.xs,
    color: theme.font.color.tertiary,
  };

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={name}
      aria-current={selected}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[0.5],
        width: '100%',
        textAlign: 'left',
        border: 'none',
        borderBottom: `1px solid ${theme.border.color.light}`,
        borderLeft: `2px solid ${selected ? theme.color.blue : 'transparent'}`,
        background: selected ? theme.background.transparent.light : 'transparent',
        color: theme.font.color.primary,
        cursor: 'pointer',
        padding: theme.spacing[2],
        fontFamily: theme.font.family,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'baseline', gap: theme.spacing[1] }}>
        <span
          style={{
            fontWeight:
              (thread.unreadCount ?? 0) > 0
                ? theme.font.weight.semiBold
                : theme.font.weight.regular,
            fontSize: theme.font.size.md,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name === '' ? displayPhone(thread.waId) : name}
        </span>
        <span style={{ flex: '1 1 auto' }} />
        <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
          {relativeTime(thread.lastMessageAt, now, lang)}
        </span>
      </span>

      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[1],
          fontSize: theme.font.size.sm,
          color: theme.font.color.tertiary,
          overflow: 'hidden',
          maxWidth: '100%',
        }}
      >
        <Glyph
          name={thread.lastMessageDirection === 'OUTBOUND' ? 'send' : 'inbox'}
          label={t(
            thread.lastMessageDirection === 'OUTBOUND' ? 'chat.send' : 'inbox.conversations',
          )}
        />
        <span
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {thread.lastMessagePreview ?? ''}
        </span>
      </span>

      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[2],
          flexWrap: 'wrap',
        }}
      >
        {(thread.unreadCount ?? 0) > 0 ? (
          <span
            style={{
              fontSize: theme.font.size.xs,
              fontWeight: theme.font.weight.medium,
              background: theme.color.blue,
              color: theme.font.color.inverted,
              borderRadius: theme.border.radius.pill,
              padding: `0 ${theme.spacing[1]}`,
              minWidth: '16px',
              textAlign: 'center',
            }}
          >
            {thread.unreadCount}
          </span>
        ) : null}

        {/*
          Every badge carries its word as an accessible name, because the row
          is a single button: a screen reader reads it as one string, and four
          bare glyphs in that string are four unexplained noises.
        */}
        {remaining === null ? null : (
          <span style={{ ...badge, color: theme.color.green }}>
            <Glyph name="windowOpen" />
            {remaining}
          </span>
        )}
        {thread.originCampaignId === null ? null : (
          <span style={badge}>
            <Glyph name="campaign_replies" />
            {t('chat.campaign')}
          </span>
        )}
        {thread.status === 'NEEDS_REVIEW' ? (
          <span style={badge}>
            <Glyph name="needsReview" />
            {t('chat.needsReview')}
          </span>
        ) : null}
        {mine ? (
          <span style={badge}>
            <Glyph name="mine" />
            {t('chat.assignedToYou')}
          </span>
        ) : thread.assigneeId === null ? (
          <span style={badge}>
            <Glyph name="unassigned" />
            {t('chat.unassigned')}
          </span>
        ) : null}
      </span>
    </button>
  );
};

/**
 * The layout, as a stylesheet.
 *
 * Built from the theme rather than hard-coded, and injected once per mounted
 * inbox. Two identical `<style>` elements are harmless; two *different*
 * breakpoints would not be, which is why the number comes from the constant
 * above rather than from the string.
 */
const layoutCss = (borderColor: string): string => `
.wa-inbox { container-type: inline-size; container-name: wa-inbox; }
.wa-inbox-panes { display: flex; flex: 1 1 auto; min-height: 0; }
.wa-inbox-list {
  display: flex; flex-direction: column; flex: 1 1 auto;
  min-height: 0; min-width: 0; overflow-y: auto;
}
.wa-inbox-detail { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; }
.wa-inbox[data-detail="open"] .wa-inbox-list { display: none; }
.wa-inbox[data-detail="closed"] .wa-inbox-detail { display: none; }
/*
  The back button's own display lives here rather than in its style attribute,
  because an inline style beats a stylesheet rule at any specificity — and the
  container query below has to be able to hide it.
*/
.wa-inbox-back { display: inline-flex; align-items: center; }
/*
  The collapse toggle only means anything in the two-pane layout: in the narrow
  one the list and the conversation are already alternatives, and Back is how
  you move between them.
*/
.wa-inbox-collapse { display: none; }
@container wa-inbox (min-width: ${TWO_PANE_MIN_WIDTH}px) {
  .wa-inbox[data-detail="open"] .wa-inbox-list { display: flex; flex: 0 0 320px; }
  .wa-inbox[data-detail="closed"] .wa-inbox-list { flex: 0 0 320px; }
  .wa-inbox-list { border-right: 1px solid ${borderColor}; }
  .wa-inbox[data-detail="closed"] .wa-inbox-detail { display: flex; }
  .wa-inbox-back { display: none; }
  .wa-inbox-collapse { display: inline-flex; align-items: center; }
  /*
    Collapsed: the list goes, the conversation takes the whole width.

    Only ever while a conversation is open — collapsing the list with nothing
    selected would leave a pane showing an empty state and no way back to the
    thing that was hidden.
  */
  .wa-inbox[data-list="collapsed"][data-detail="open"] .wa-inbox-list { display: none; }
}
`;

export const InboxView = () => {
  const theme = useTheme();
  const { t, lang } = useCopy();
  const actions = useActions();

  const [filter, setFilter] = useState<Filter>('mine');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showAllFilters, setShowAllFilters] = useState(false);
  /**
   * Hides the conversation list so the transcript has the whole width.
   *
   * A reader working through one long conversation does not need a column of
   * other conversations beside it, and on a wide screen that column is 320px of
   * permanent furniture. Local state, not a preference: it is a per-sitting
   * choice, and persisting it would mean a rep who collapsed it once opens the
   * inbox tomorrow to no list and no obvious reason why.
   */
  const [listCollapsed, setListCollapsed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const feed = useFeed({ scope: 'inbox', filter });

  /**
   * A second, much slower read purely for the badges.
   *
   * Deliberately not folded into the list poll: the totals cost six queries
   * and the list is re-read every eight seconds. Thirty seconds is
   * comfortably fresh for a number beside a filter name, and it is one extra
   * request every thirty seconds rather than six extra reads every eight.
   */
  const counts = useFeed({
    scope: 'inbox',
    filter: 'all',
    counts: true,
    // One row, not fifty: this read exists for the six totals beside it.
    limit: 1,
    intervalMs: COUNTS_INTERVAL_MS,
  });

  const threads = feed.data?.threads ?? [];
  const account = feed.data?.account ?? null;
  const viewerId = feed.data?.permissions.workspaceMemberId ?? null;
  const canSend = feed.data?.permissions.canSend === true;
  const now = new Date(feed.data?.serverTime ?? Date.now());

  const visible = useMemo(() => filterThreads(threads, search), [threads, search]);

  /**
   * Assigning without opening the conversation.
   *
   * The list is where a rep triages, so this is where taking a conversation
   * belongs — the header can do it too, but reaching it means opening the
   * thread you may not be taking.
   */
  /**
   * The list and the badges, together.
   *
   * They are separate polls on separate clocks — eight seconds and thirty — so
   * anything that changes a conversation's row has to wake both, or the count
   * beside "Minhas" disagrees with the rows under it for half a minute (D-64).
   */
  const refreshList = useCallback(() => {
    feed.refresh();
    counts.refresh();
  }, [counts, feed]);

  const assignToMe = useCallback(
    async (threadId: string) => {
      if (viewerId === null) return;

      const outcome = await actions.threadAction('assign', {
        threadId,
        assigneeId: viewerId,
      });

      setActionError(outcome.ok ? null : (outcome.error ?? t('chat.assignFailed')));
      refreshList();
    },
    [actions, refreshList, t, viewerId],
  );

  /**
   * J and K, and the arrows, and A.
   *
   * Bound on the root rather than on the document — a front component sharing
   * a page with the rest of the CRM must not swallow keys aimed at it — and
   * inert whenever the caret is in a field, or typing "javascript" into the
   * search box would leaf through the list one letter at a time.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? '';

      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const ids = visible.map((thread) => thread.id);
      const down = event.key === 'j' || event.key === 'J' || event.key === 'ArrowDown';
      const up = event.key === 'k' || event.key === 'K' || event.key === 'ArrowUp';

      if (down || up) {
        const next = nextThreadId(ids, selectedId, down ? 1 : -1);

        if (next === null) return;

        event.preventDefault();
        setSelectedId(next);

        return;
      }

      if ((event.key === 'a' || event.key === 'A') && selectedId !== null && canSend) {
        event.preventDefault();
        void assignToMe(selectedId);
      }
    },
    [assignToMe, canSend, selectedId, visible],
  );

  const shown = showAllFilters ? FILTERS : FILTERS.filter((key) => PRIMARY.includes(key));

  return (
    <div
      className="wa-inbox"
      data-detail={selectedId === null ? 'closed' : 'open'}
      data-list={listCollapsed ? 'collapsed' : 'expanded'}
      {...feed.rootProps}
      onKeyDown={(event) => {
        feed.rootProps.onKeyDown();
        onKeyDown(event);
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        /**
         * A height, not a percentage. The page sizes itself to us rather than
         * the other way round, so `100%` resolves to `auto` and the inbox would
         * be as tall as its content — a two-row list in a 400px box on a
         * 1400px screen, and a page-scrolling column when the list is long.
         *
         * The *page* height, not the embedded one: the inbox is not a widget
         * beside a record's fields, it is the whole page, and the embedded cap
         * left a quarter of the viewport empty under the composer.
         * See `SURFACE_PAGE_HEIGHT`.
         */
        height: SURFACE_PAGE_HEIGHT,
        minHeight: SURFACE_MIN_HEIGHT,
        background: theme.background.primary,
        color: theme.font.color.primary,
        fontFamily: theme.font.family,
        overflow: 'hidden',
      }}
    >
      <style>{layoutCss(theme.border.color.light)}</style>

      {/* Renders nothing; polls `mine` and raises the snackbars (D-10 layer 2). */}
      <InboundToaster />

      {account !== null && account.status !== 'CONNECTED' ? (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            padding: theme.spacing[2],
            fontSize: theme.font.size.md,
            background: theme.background.transparent.danger,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="warning" size="md" />
          {t('chat.accountError')}
        </div>
      ) : null}

      {account?.qualityRating === 'RED' || account?.qualityRating === 'YELLOW' ? (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            padding: theme.spacing[2],
            fontSize: theme.font.size.md,
            background: theme.background.transparent.light,
            color: theme.font.color.secondary,
          }}
        >
          <Glyph name="warning" size="md" />
          {account.qualityRating === 'RED' ? t('chat.qualityRed') : t('chat.qualityYellow')}
          {account.isTestAccount ? ` · ${t('chat.testAccount')}` : ''}
        </div>
      ) : null}

      {feed.isStale ? (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            padding: theme.spacing[2],
            fontSize: theme.font.size.md,
            background: theme.background.transparent.danger,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="warning" size="md" />
          {t('chat.offline')}
        </div>
      ) : null}

      {actionError === null ? null : <Banner tone="danger">{actionError}</Banner>}

      <div className="wa-inbox-panes">
        <div className="wa-inbox-list">
          {/*
            Search and filters live in the list pane, above the rows they act
            on. They used to span the whole widget, which put the control for a
            320px column across a 1400px screen and left it sitting above the
            conversation it had nothing to do with.
          */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: theme.spacing[1],
              padding: theme.spacing[1],
              borderBottom: `1px solid ${theme.border.color.light}`,
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
                padding: `0 ${theme.spacing[1]}`,
                minHeight: '32px',
              }}
            >
              <Glyph name="search" />
              <input
                type="search"
                value={search}
                placeholder={t('inbox.search')}
                aria-label={t('inbox.search')}
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
              {search === '' ? null : (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label={t('inbox.clearSearch')}
                  title={t('inbox.clearSearch')}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: '24px',
                    minHeight: '24px',
                    border: 'none',
                    background: 'transparent',
                    color: theme.font.color.tertiary,
                    cursor: 'pointer',
                  }}
                >
                  <Glyph name="dismiss" />
                </button>
              )}
            </div>

            <div style={{ display: 'flex', gap: theme.spacing[1], flexWrap: 'wrap' }}>
              {shown.map((key) => (
                <FilterChip
                  key={key}
                  active={filter === key}
                  icon={FILTER_ICON[key]}
                  label={t(`inbox.${key}`)}
                  count={counts.data?.counts?.[key]}
                  onClick={() => setFilter(key)}
                  t={t}
                />
              ))}

              <button
                type="button"
                onClick={() => setShowAllFilters((current) => !current)}
                aria-expanded={showAllFilters}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: theme.spacing[1],
                  minHeight: '28px',
                  border: `1px solid ${theme.border.color.light}`,
                  borderRadius: theme.border.radius.pill,
                  background: 'transparent',
                  color: theme.font.color.secondary,
                  cursor: 'pointer',
                  fontFamily: theme.font.family,
                  fontSize: theme.font.size.sm,
                  padding: `0 ${theme.spacing[2]}`,
                  whiteSpace: 'nowrap',
                }}
              >
                <Glyph name="filter" />
                {t(showAllFilters ? 'inbox.fewerFilters' : 'inbox.moreFilters')}
              </button>
            </div>

            {search === '' ? null : (
              <span
                style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}
              >
                {t('inbox.searchScope', { count: threads.length })}
              </span>
            )}
          </div>

          {/*
            The conversation on the right can leave the list on the left: a
            closed thread stays open in the detail pane while the current
            filter no longer contains it — most sharply when acting on the
            thread (close, assign) is what moved it. Without this line, a
            list that empties beside a conversation that is plainly there
            reads as data loss.
          */}
          {selectedId !== null &&
          !feed.isLoading &&
          !feed.isUnavailable &&
          !visible.some((thread) => thread.id === selectedId) ? (
            <div
              role="status"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: theme.spacing[1],
                padding: theme.spacing[2],
                fontSize: theme.font.size.xs,
                color: theme.font.color.tertiary,
                borderBottom: `1px solid ${theme.border.color.light}`,
              }}
            >
              <Glyph name="details" />
              {t('inbox.openNotInFilter')}
            </div>
          ) : null}

          {/*
            "No conversations in this filter" is a claim about the data, and
            a surface that could not read anything is not entitled to make
            it. The four states are kept apart: unreadable, still reading,
            filtered to nothing by a search, and genuinely empty.
          */}
          {feed.isUnavailable ? (
            <EmptyState
              icon="warning"
              title={t('common.unavailable')}
              body={feed.error ?? undefined}
              actions={
                <ActionButton label={t('common.retry')} icon="retry" onClick={feed.refresh} />
              }
            />
          ) : feed.isLoading && feed.data === null ? (
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
          ) : threads.length === 0 && !feed.isLoading ? (
            <EmptyState
              icon={FILTER_ICON[filter]}
              title={t(`inbox.empty.${filter}`)}
              body={t(`inbox.empty.${filter}Body`)}
              actions={
                filter === 'all' ? undefined : (
                  <>
                    {filter === 'mine' ? (
                      <ActionButton
                        label={t('inbox.seeUnassigned')}
                        icon="unassigned"
                        onClick={() => setFilter('unassigned')}
                      />
                    ) : null}
                    <ActionButton
                      label={t('inbox.seeAll')}
                      icon="all"
                      onClick={() => setFilter('all')}
                    />
                  </>
                )
              }
            />
          ) : visible.length === 0 ? (
            <EmptyState
              icon="search"
              title={t('inbox.noMatches', { query: search })}
              actions={
                <ActionButton
                  label={t('inbox.clearSearch')}
                  icon="dismiss"
                  onClick={() => setSearch('')}
                />
              }
            />
          ) : null}

          {visible.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              selected={thread.id === selectedId}
              onSelect={() => setSelectedId(thread.id)}
              now={now}
              lang={lang}
              t={t}
              viewerId={viewerId}
            />
          ))}

          {visible.length === 0 ? null : (
            <span
              style={{
                padding: theme.spacing[2],
                fontSize: theme.font.size.xs,
                color: theme.font.color.tertiary,
              }}
            >
              {t('inbox.keyboardHint')}
            </span>
          )}
        </div>

        <div className="wa-inbox-detail">
          {/*
            Only rendered in the narrow layout, and hidden by the container
            query rather than by a measurement — so a resize reveals or hides
            it in the same frame the panes rearrange.
          */}
          {selectedId === null ? null : (
            <button
              type="button"
              className="wa-inbox-back"
              onClick={() => setSelectedId(null)}
              aria-label={t('inbox.conversations')}
              style={{
                gap: theme.spacing[1],
                alignSelf: 'flex-start',
                minHeight: '32px',
                border: 'none',
                background: 'transparent',
                color: theme.font.color.secondary,
                cursor: 'pointer',
                fontFamily: theme.font.family,
                fontSize: theme.font.size.md,
                padding: theme.spacing[2],
              }}
            >
              <Glyph name="back" size="md" />
              {t('inbox.conversations')}
            </button>
          )}

          {/*
            The wide-layout counterpart of Back: same place, same job — control
            over how much of the widget the conversation gets — but it hides the
            list rather than returning to it. The container query decides which
            of the two is on screen; neither is ever both.
          */}
          {selectedId === null ? null : (
            <button
              type="button"
              className="wa-inbox-collapse"
              onClick={() => setListCollapsed((current) => !current)}
              aria-pressed={listCollapsed}
              aria-label={t(listCollapsed ? 'inbox.showList' : 'inbox.hideList')}
              title={t(listCollapsed ? 'inbox.showList' : 'inbox.hideList')}
              style={{
                gap: theme.spacing[1],
                alignSelf: 'flex-start',
                minHeight: '32px',
                border: 'none',
                background: 'transparent',
                color: theme.font.color.tertiary,
                cursor: 'pointer',
                fontFamily: theme.font.family,
                fontSize: theme.font.size.sm,
                padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
              }}
            >
              <Glyph name={listCollapsed ? 'chevron' : 'back'} />
              {t(listCollapsed ? 'inbox.showList' : 'inbox.hideList')}
            </button>
          )}

          {selectedId === null ? (
            <EmptyState icon="inbox" title={t('inbox.pick')} body={t('inbox.pickBody')} />
          ) : (
            /*
              The pane tells the list when the conversation changed as a *row*
              — assigned, closed, blocked, linked. Without it the two halves of
              this screen ran on their own clocks and contradicted each other
              for up to thirty seconds after every action taken on the right
              (D-64).
            */
            <ThreadView
              threadId={selectedId}
              variant="inbox"
              onThreadChanged={refreshList}
            />
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * One filter, with its mark and its total.
 *
 * `aria-pressed` rather than a `twenty-ui` chip, which carries no pressed
 * state — but at chip scale: `sm` text and a 28px box, not the 16px-high
 * 8px-type pills the review measured. The count is folded into the accessible
 * name so a screen reader reads "Minhas, 4 conversas" rather than "Minhas 4".
 */
const FilterChip = ({
  active,
  icon,
  label,
  count,
  onClick,
  t,
}: {
  active: boolean;
  icon: IconName;
  label: string;
  count: number | undefined;
  onClick: () => void;
  t: Translate;
}) => {
  const theme = useTheme();

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={count === undefined ? label : t('inbox.filterCount', { label, count })}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.spacing[1],
        minHeight: '28px',
        /**
         * The selected chip wears the accent, not merely a darker grey. A
         * strong-grey border on a light-grey background was the review's
         * "which filter am I in?" — the same blue-border-plus-tint the
         * attachment panel's radios already use.
         */
        border: `1px solid ${active ? theme.color.blue : theme.border.color.light}`,
        borderRadius: theme.border.radius.pill,
        background: active ? theme.background.transparent.blue : 'transparent',
        color: active ? theme.font.color.primary : theme.font.color.secondary,
        cursor: 'pointer',
        fontFamily: theme.font.family,
        fontSize: theme.font.size.sm,
        fontWeight: active ? theme.font.weight.medium : theme.font.weight.regular,
        padding: `0 ${theme.spacing[2]}`,
        whiteSpace: 'nowrap',
      }}
    >
      <Glyph name={icon} />
      {label}
      {count === undefined ? null : (
        <span aria-hidden="true" style={{ color: theme.font.color.tertiary }}>
          {count}
        </span>
      )}
    </button>
  );
};
