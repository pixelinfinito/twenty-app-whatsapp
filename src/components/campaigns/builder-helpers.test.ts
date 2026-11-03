import { describe, expect, it } from 'vitest';

import { resolveParameters } from '../../domain/campaign/variable-resolution';
import type { AccountProjection } from '../../domain/feed/projection';
import type { VariableSpec } from '../../domain/template-spec';
import {
  accountWarnings,
  bindingsFromMapping,
  buildVariableMapping,
  openedFrom,
  standIn,
} from './CampaignBuilder';

type Binding = Parameters<typeof standIn>[0];

const account = (over: Partial<AccountProjection> = {}): AccountProjection => ({
  id: 'a1',
  name: 'Vendas',
  status: 'CONNECTED',
  statusDetail: null,
  qualityRating: 'GREEN',
  messagingLimitTier: 'TIER_1K',
  tierUniqueUsersUsed: 0,
  displayPhoneNumber: '+244 923 456 789',
  displayName: 'Vendas',
  isTestAccount: false,
  webhookLastEventAt: null,
  webhookLastVerifiedAt: null,
  tokenLastCheckedAt: null,
  ...over,
});

/**
 * The Review step's job is to say what is wrong *before* anybody builds an
 * audience. Three of these are survivable and one of them means the campaign
 * will not start at all, so they are separate strings rather than one banner.
 */
describe('accountWarnings', () => {
  it('says nothing about a healthy number', () => {
    expect(accountWarnings(account())).toEqual([]);
  });

  it('treats no account at all as a disconnected one', () => {
    expect(accountWarnings(null)).toEqual(['campaign.warnNotConnected']);
  });

  it('reports a number that is not connected', () => {
    expect(accountWarnings(account({ status: 'PENDING' }))).toEqual([
      'campaign.warnNotConnected',
    ]);
  });

  it('reports a red rating, which the launch gate will ask about again', () => {
    expect(accountWarnings(account({ qualityRating: 'RED' }))).toEqual([
      'campaign.warnQualityRed',
    ]);
  });

  it('reports a yellow rating without pretending it blocks anything', () => {
    expect(accountWarnings(account({ qualityRating: 'YELLOW' }))).toEqual([
      'campaign.warnQualityYellow',
    ]);
  });

  /** Meta only delivers a test number's messages to registered recipients. */
  it('reports a test number', () => {
    expect(accountWarnings(account({ isTestAccount: true }))).toEqual([
      'campaign.warnTestAccount',
    ]);
  });

  it('reports every problem a number has at once', () => {
    expect(
      accountWarnings(account({ status: 'ERROR', qualityRating: 'RED', isTestAccount: true })),
    ).toEqual([
      'campaign.warnNotConnected',
      'campaign.warnQualityRed',
      'campaign.warnTestAccount',
    ]);
  });
});

/**
 * The Variables step's preview updates on every keystroke, so it cannot ask the
 * server what a contact's name is. What it can do is show the *shape* of the
 * finished sentence without ever pretending a stand-in is real data.
 */
describe('standIn', () => {
  it('shows a static binding as itself', () => {
    expect(standIn({ kind: 'static', path: '', value: 'Agosto', fallback: '' })).toBe('Agosto');
  });

  it('falls back to the fallback when a static binding is still empty', () => {
    expect(standIn({ kind: 'static', path: '', value: '', fallback: 'cliente' })).toBe(
      'cliente',
    );
  });

  /** Guillemets, so nobody reads it as the contact's actual first name. */
  it('shows a field binding as the field name in guillemets', () => {
    expect(
      standIn({ kind: 'field', path: 'person.name.firstName', value: '', fallback: '' }),
    ).toBe('«firstName»');
  });

  /**
   * An empty string leaves `bindPlaceholders` alone, so the preview keeps
   * showing `{{1}}` — which is the honest thing for a binding nobody has
   * chosen yet.
   */
  it('resolves to nothing when a field binding has no path', () => {
    expect(standIn({ kind: 'field', path: '', value: '', fallback: '' })).toBe('');
  });
});

/**
 * D-59. The builder wrote `{ body }` and the resolver reads a header and
 * buttons too, so a campaign on a template with either was buildable,
 * launchable, and excluded every single recipient for "missing variables" —
 * with nothing on any screen naming a component the form had never asked
 * about. These tests hold the two shapes together.
 */
describe('buildVariableMapping', () => {
  const spec = (over: Partial<VariableSpec> = {}): VariableSpec => ({
    namedParameters: false,
    header: null,
    body: {
      variableCount: 2,
      indices: [1, 2],
      names: [],
      text: 'Olá {{1}}, {{2}}',
      example: [],
    },
    footer: null,
    buttons: [],
    totalVariableCount: 2,
    ...over,
  });

  const field = (path: string): Binding => ({ kind: 'field', path, value: '', fallback: '' });
  const empty = { bindings: [], headerBindings: [], headerFileUrl: '', buttonBindings: {} };

  it('maps body variables onto Meta’s own 1-based indices', () => {
    const mapping = buildVariableMapping({
      ...empty,
      spec: spec(),
      bindings: [field('person.name.firstName'), field('person.city')],
    });

    expect(mapping.body).toEqual([
      { index: 1, kind: 'field', path: 'person.name.firstName' },
      { index: 2, kind: 'field', path: 'person.city' },
    ]);
  });

  it('says nothing about a header or buttons a template does not have', () => {
    const mapping = buildVariableMapping({ ...empty, spec: spec() });

    expect(mapping.header).toBeUndefined();
    expect(mapping.buttons).toBeUndefined();
  });

  it('carries a media header’s file for the whole campaign', () => {
    const mapping = buildVariableMapping({
      ...empty,
      spec: spec({
        header: {
          format: 'IMAGE',
          variableCount: 0,
          indices: [],
          names: [],
          text: null,
          example: [],
        },
      }),
      headerFileUrl: ' https://crm.test/files/attachment/convite.png ',
    });

    expect(mapping.header).toEqual({
      kind: 'media',
      fileUrl: 'https://crm.test/files/attachment/convite.png',
    });
  });

  /**
   * An address the sender cannot read is worse than none: it resolves, so the
   * campaign launches, and then fails for every recipient (D-58).
   */
  it('refuses an address outside Twenty’s file store', () => {
    const mapping = buildVariableMapping({
      ...empty,
      spec: spec({
        header: {
          format: 'IMAGE',
          variableCount: 0,
          indices: [],
          names: [],
          text: null,
          example: [],
        },
      }),
      headerFileUrl: 'https://images.example.test/convite.png',
    });

    expect(mapping.header).toEqual({ kind: 'media', fileUrl: null });
  });

  it('binds a text header per recipient, 1-based like the body', () => {
    const mapping = buildVariableMapping({
      ...empty,
      spec: spec({
        header: {
          format: 'TEXT',
          variableCount: 1,
          indices: [1],
          names: [],
          text: 'Convite para {{1}}',
          example: [],
        },
      }),
      headerBindings: [field('account.displayName')],
    });

    expect(mapping.header).toEqual({
      kind: 'text',
      bindings: [{ index: 1, kind: 'field', path: 'account.displayName' }],
    });
  });

  /** Buttons keep Meta's 0-based index and carry the sub_type the payload needs. */
  it('binds only the buttons that have a variable', () => {
    const mapping = buildVariableMapping({
      ...empty,
      spec: spec({
        buttons: [
          { index: 0, type: 'QUICK_REPLY', hasVariable: false, text: 'Sim', url: null },
          { index: 1, type: 'URL', hasVariable: true, text: 'Abrir', url: 'https://x/{{1}}' },
        ],
      }),
      buttonBindings: { 1: field('person.id') },
    });

    expect(mapping.buttons).toEqual([
      { index: 1, kind: 'field', path: 'person.id', subType: 'url' },
    ]);
  });

  /**
   * The template QA got stuck on, end to end: six body variables, an image
   * header and a dynamic button all reach the resolver.
   */
  it('covers every variable the resolver counts', () => {
    const full = spec({
      header: {
        format: 'IMAGE',
        variableCount: 0,
        indices: [],
        names: [],
        text: null,
        example: [],
      },
      buttons: [
        { index: 0, type: 'URL', hasVariable: true, text: 'Confirmar', url: 'https://x/{{1}}' },
      ],
    });

    const mapping = buildVariableMapping({
      spec: full,
      bindings: [field('person.name.firstName'), field('person.city')],
      headerBindings: [],
      headerFileUrl: 'https://crm.test/files/attachment/convite.png',
      buttonBindings: { 0: { kind: 'static', path: '', value: 'abc', fallback: '' } },
    });

    const resolved = resolveParameters({
      spec: full,
      mapping,
      subject: {
        person: { name: { firstName: 'Marcos' }, city: 'Luanda' },
        now: new Date('2026-08-17T10:00:00Z'),
      },
    });

    expect(resolved.ok).toBe(true);
  });
});

/**
 * D-61. A draft was a one-way door: the builder wrote one on every step, the
 * detail screen could show it, and nothing led back in — so an interrupted
 * campaign was work that could only be deleted and redone. Reopening is only a
 * resume if the form comes back filled and lands where it was left.
 */
describe('openedFrom', () => {
  const templates = [
    {
      id: 'tpl-1',
      name: 'convite',
      language: 'pt_PT',
      category: 'MARKETING',
      variableSpec: {
        namedParameters: false,
        header: null,
        body: {
          variableCount: 2,
          indices: [1, 2],
          names: [],
          text: 'Olá {{1}}, {{2}}',
          example: [],
        },
        footer: null,
        buttons: [],
        totalVariableCount: 2,
      },
    },
  ] as unknown as Parameters<typeof openedFrom>[1];

  it('starts an empty builder when there is nothing to reopen', () => {
    expect(openedFrom(null, templates)).toMatchObject({ campaignId: null, step: 0, name: '' });
  });

  it('reads the fields back out of the record', () => {
    const opened = openedFrom(
      {
        id: 'c-1',
        name: 'Convite Agosto',
        accountId: 'acc-1',
        templateId: 'tpl-1',
        scheduledAt: '2026-09-01T09:30:00.000Z',
        audienceDefinition: { kind: 'view', viewId: 'view-9' },
        variableMapping: {
          body: [
            { index: 1, kind: 'field', path: 'person.name.firstName' },
            { index: 2, kind: 'static', value: 'Luanda', fallback: 'Angola' },
          ],
        },
      },
      templates,
    );

    expect(opened).toMatchObject({
      campaignId: 'c-1',
      name: 'Convite Agosto',
      accountId: 'acc-1',
      templateId: 'tpl-1',
      audienceKind: 'view',
      viewId: 'view-9',
    });
    expect(opened.bindings).toEqual([
      { kind: 'field', path: 'person.name.firstName', value: '', fallback: '' },
      { kind: 'static', path: '', value: 'Luanda', fallback: 'Angola' },
    ]);
  });

  /**
   * `datetime-local` reads `YYYY-MM-DDTHH:mm` and nothing else. Handing it the
   * whole ISO instant leaves the box empty, which reads as "not scheduled" for
   * a campaign that is.
   */
  it('restores a stored instant in the browser time zone', () => {
    const instant = '2026-09-01T09:30:00.000Z';
    const local = openedFrom({ id: 'c-1', scheduledAt: instant }, templates).scheduledAt;
    expect(new Date(local).toISOString()).toBe(instant);
  });

  it('joins a manual audience back into the text area it came from', () => {
    expect(
      openedFrom(
        { id: 'c-1', audienceDefinition: { kind: 'manual', personIds: ['p1', 'p2'] } },
        templates,
      ),
    ).toMatchObject({ audienceKind: 'manual', personIds: ['p1', 'p2'] });
  });

  /** The furthest step already answered — a resume that starts over is not one. */
  it.each([
    ['nothing at all', {}, 0],
    ['a name and a number', { name: 'x', accountId: 'a' }, 1],
    ['a template', { name: 'x', accountId: 'a', templateId: 'tpl-1' }, 2],
    [
      'an audience',
      {
        name: 'x',
        accountId: 'a',
        templateId: 'tpl-1',
        audienceDefinition: { kind: 'view', viewId: 'v' },
      },
      3,
    ],
  ])('opens on the step after %s', (_label, record, step) => {
    expect(openedFrom({ id: 'c-1', ...record }, templates).step).toBe(step);
  });

  /** An audience naming a view that was never chosen is not an audience. */
  it('does not count an empty view as an audience', () => {
    expect(
      openedFrom(
        {
          id: 'c-1',
          name: 'x',
          accountId: 'a',
          templateId: 'tpl-1',
          audienceDefinition: { kind: 'view', viewId: '' },
        },
        templates,
      ).step,
    ).toBe(2);
  });
});

/** What the builder writes must be what it reads back. */
describe('a mapping survives a round trip through the form', () => {
  const spec: VariableSpec = {
    namedParameters: false,
    header: {
      format: 'IMAGE',
      variableCount: 0,
      indices: [],
      names: [],
      text: null,
      example: [],
    },
    body: {
      variableCount: 2,
      indices: [1, 2],
      names: [],
      text: 'Olá {{1}}, {{2}}',
      example: [],
    },
    footer: null,
    buttons: [
      { index: 0, type: 'URL', hasVariable: true, text: 'Abrir', url: 'https://x/{{1}}' },
    ],
    totalVariableCount: 3,
  };

  it('reads back every component it wrote', () => {
    const form = {
      spec,
      bindings: [
        { kind: 'field' as const, path: 'person.name.firstName', value: '', fallback: '' },
        { kind: 'static' as const, path: '', value: 'Luanda', fallback: '' },
      ],
      headerBindings: [],
      headerFileUrl: 'https://crm.test/files/attachment/convite.png',
      buttonBindings: {
        0: { kind: 'field' as const, path: 'person.id', value: '', fallback: '' },
      },
    };

    const reopened = bindingsFromMapping(spec, buildVariableMapping(form));

    expect(reopened.bindings).toEqual(form.bindings);
    expect(reopened.headerFileUrl).toBe(form.headerFileUrl);
    expect(reopened.buttonBindings).toEqual(form.buttonBindings);
  });
});
