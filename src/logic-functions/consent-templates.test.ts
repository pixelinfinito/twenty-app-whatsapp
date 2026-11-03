import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONSENT_METHOD,
  CONSENT_STATUS,
  QUALITY,
  TEMPLATE_CATEGORY,
  TEMPLATE_STATUS,
} from '../domain/constants';
import type { MetaTemplateComponent } from '../domain/template-spec';
import {
  OWN_WRITE_WINDOW_MS,
  isAlreadyRecorded,
} from './wa-consent-backfill';
import {
  confirmationText,
  consentIntent,
  consentWordingDrift,
} from './wa-consent-keyword';
import { MAX_IMPORT_ROWS, parseMethod, parseStatus } from './wa-consent-route';
import {
  TEMPLATE_NAME_PATTERN,
  missingExamples,
  submitCountKey,
} from './wa-template-submit';
import {
  MAX_PAGES,
  shouldUnpublish,
  templateCategoryFor,
  templateStatusFor,
} from './wa-template-sync';
import { componentsFromUpdate, mergeComponents } from './wa-template-event';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const KEYWORDS = {
  optOut: ['STOP', 'SAIR', 'PARAR', 'CANCELAR'],
  optIn: ['START', 'INICIAR', 'SIM'],
};

describe('reading a consent keyword', () => {
  it.each(['STOP', 'stop', 'Sair', 'PARAR', '  cancelar  '])(
    'reads %p as an opt-out',
    (body) => {
      expect(consentIntent(body, KEYWORDS)).toBe(CONSENT_STATUS.OPTED_OUT);
    },
  );

  it.each(['START', 'iniciar', 'Sim'])('reads %p as an opt-in', (body) => {
    expect(consentIntent(body, KEYWORDS)).toBe(CONSENT_STATUS.OPTED_IN);
  });

  /**
   * The spec's own counterexample. Substring matching would opt this person out
   * of a message in which they say they will keep recommending us — an
   * unrecoverable error, since nothing tells us it was wrong.
   */
  it('does not opt out someone who merely used the word', () => {
    expect(consentIntent('não vou parar de recomendar', KEYWORDS)).toBeNull();
    expect(consentIntent('quero cancelar a minha encomenda de sexta', KEYWORDS)).toBeNull();
  });

  it.each([null, '', '   ', '👍'])('reads %p as no keyword', (body) => {
    expect(consentIntent(body, KEYWORDS)).toBeNull();
  });

  /**
   * The lists are operator-editable, so a word can end up in both. An opt-out
   * is the only safe reading: a missed opt-in is a message not sent, a missed
   * opt-out is a message sent to someone who asked us to stop.
   */
  it('treats a word in both lists as an opt-out', () => {
    expect(consentIntent('SIM', { optOut: ['SIM'], optIn: ['SIM'] })).toBe(
      CONSENT_STATUS.OPTED_OUT,
    );
  });
});

describe('the confirmation wording', () => {
  it('uses Portuguese by default', () => {
    expect(confirmationText(CONSENT_STATUS.OPTED_OUT)).toContain('Não voltará a receber');
    expect(confirmationText(CONSENT_STATUS.OPTED_IN)).toContain('Obrigado');
  });

  it('switches to English when the locale says so', () => {
    process.env.WA_CONFIRMATION_LOCALE = 'en';

    expect(confirmationText(CONSENT_STATUS.OPTED_OUT)).toContain('will not receive');
    expect(confirmationText(CONSENT_STATUS.OPTED_IN)).toContain('Thank you');
  });

  /** Counsel reviews this wording (Q-4); it must be editable without a deploy. */
  it('takes whatever wording the operator configured', () => {
    process.env.WA_OPT_OUT_CONFIRMATION_PT = 'Pedido registado.';

    expect(confirmationText(CONSENT_STATUS.OPTED_OUT)).toBe('Pedido registado.');
  });

  it('tells the contact how to reverse the decision', () => {
    expect(confirmationText(CONSENT_STATUS.OPTED_OUT)).toMatch(/INICIAR/);
    expect(confirmationText(CONSENT_STATUS.OPTED_IN)).toMatch(/SAIR/);
  });

  /**
   * The drift-proof alternative to spelling the word out. An operator who
   * localises the keyword lists can write the placeholder once and never have
   * the confirmation and the matcher disagree again.
   */
  it('resolves the keyword placeholders from the live lists', () => {
    process.env.WA_OPT_OUT_KEYWORDS = 'CHEGA,BASTA';
    process.env.WA_OPT_IN_CONFIRMATION_PT = 'Responda {optOutKeyword} para parar.';

    expect(confirmationText(CONSENT_STATUS.OPTED_IN)).toBe('Responda CHEGA para parar.');
  });

  /** Naming no word at all is worse than naming the shipped one. */
  it('falls back to the shipped keyword when the list is empty', () => {
    process.env.WA_OPT_OUT_KEYWORDS = '';
    process.env.WA_OPT_IN_CONFIRMATION_PT = 'Responda {optOutKeyword} para parar.';

    expect(confirmationText(CONSENT_STATUS.OPTED_IN)).toBe('Responda STOP para parar.');
  });
});

/**
 * The silent-failure case from issue #1: an admin localises
 * `WA_OPT_OUT_KEYWORDS`, drops `SAIR`, and the confirmation goes on telling
 * customers to reply a word the matcher will no longer accept. Nothing errors
 * — the message sends, and the customer's opt-out is simply ignored.
 */
describe('drift between the confirmations and the keyword lists', () => {
  const LISTS = { optOut: ['STOP', 'SAIR'], optIn: ['START', 'INICIAR'] };

  it('is silent when the quoted words are still recognised', () => {
    expect(
      consentWordingDrift(
        {
          optOutConfirmation: 'Para voltar a receber, responda INICIAR.',
          optInConfirmation: 'Para parar, responda SAIR.',
        },
        LISTS,
      ),
    ).toEqual([]);
  });

  it('names the word an admin removed from the list', () => {
    const drift = consentWordingDrift(
      { optOutConfirmation: 'Responda INICIAR.', optInConfirmation: 'Responda SAIR.' },
      { optOut: ['STOP', 'PARAR'], optIn: ['START', 'INICIAR'] },
    );

    expect(drift).toEqual([
      { text: 'optInConfirmation', word: 'SAIR', expectedIn: 'optOut' },
    ]);
  });

  /**
   * The pairing is the easy thing to get backwards, and getting it backwards
   * would report every correct install as broken: the opt-*out* confirmation
   * names an opt-*in* word, because it is telling the customer how to return.
   */
  it('checks each confirmation against the opposite list', () => {
    const drift = consentWordingDrift(
      { optOutConfirmation: 'Responda SAIR.', optInConfirmation: 'Responda INICIAR.' },
      LISTS,
    );

    expect(drift.map((entry) => entry.word).sort()).toEqual(['INICIAR', 'SAIR']);
  });

  /**
   * A brand or an acronym in the wording is not a consent keyword, and a
   * health row that reddens over one is a health row people learn to ignore.
   */
  it('ignores capitalised words that were never keywords', () => {
    expect(
      consentWordingDrift(
        {
          optOutConfirmation: 'A ACME já não lhe envia mensagens. Responda INICIAR.',
          optInConfirmation: 'Obrigado — ACME. Responda SAIR.',
        },
        LISTS,
      ),
    ).toEqual([]);
  });

  it('cannot drift when the wording uses the placeholders', () => {
    expect(
      consentWordingDrift(
        {
          optOutConfirmation: 'Responda {optInKeyword}.',
          optInConfirmation: 'Responda {optOutKeyword}.',
        },
        { optOut: ['CHEGA'], optIn: ['VOLTAR'] },
      ),
    ).toEqual([]);
  });
});

describe('the consent route’s input rules', () => {
  it.each(['OPTED_IN', 'opted_out', ' Opted_In '])('accepts %p', (value) => {
    expect(parseStatus(value)).not.toBeNull();
  });

  /**
   * `UNKNOWN` is the absence of a decision, so setting it would mean deleting
   * evidence — which is the erasure routine's job, with an audit trail and a
   * confirmation. Allowing it here would be the easiest way to lose an opt-out.
   */
  it.each(['UNKNOWN', 'unknown', 'MAYBE', '', null, 42])('refuses %p', (value) => {
    expect(parseStatus(value)).toBeNull();
  });

  it('falls back to the caller’s default method rather than guessing', () => {
    expect(parseMethod('KEYWORD', CONSENT_METHOD.IN_THREAD)).toBe(CONSENT_METHOD.KEYWORD);
    expect(parseMethod('nonsense', CONSENT_METHOD.IN_THREAD)).toBe(CONSENT_METHOD.IN_THREAD);
    expect(parseMethod(undefined, CONSENT_METHOD.IMPORT)).toBe(CONSENT_METHOD.IMPORT);
  });

  it('caps an import at a batch the Core API can take', () => {
    expect(MAX_IMPORT_ROWS).toBeLessThanOrEqual(60);
  });
});

describe('back-filling a hand-edited consent field', () => {
  const now = new Date('2026-08-16T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  /**
   * `setConsent` writes the event first and the field second, so the trigger
   * always fires *after* an event already exists. Writing another would double
   * every keyword opt-out in the evidence trail.
   */
  it('skips an edit its own writer already recorded', () => {
    expect(
      isAlreadyRecorded({
        events: [{ newStatus: CONSENT_STATUS.OPTED_OUT, occurredAt: ago(2_000) }],
        newStatus: CONSENT_STATUS.OPTED_OUT,
        now,
      }),
    ).toBe(true);
  });

  it('records an edit made long after the last event', () => {
    expect(
      isAlreadyRecorded({
        events: [{ newStatus: CONSENT_STATUS.OPTED_OUT, occurredAt: ago(OWN_WRITE_WINDOW_MS * 2) }],
        newStatus: CONSENT_STATUS.OPTED_OUT,
        now,
      }),
    ).toBe(false);
  });

  it('records an edit that moves somewhere the recent event did not', () => {
    expect(
      isAlreadyRecorded({
        events: [{ newStatus: CONSENT_STATUS.OPTED_OUT, occurredAt: ago(1_000) }],
        newStatus: CONSENT_STATUS.OPTED_IN,
        now,
      }),
    ).toBe(false);
  });

  it.each([
    ['no events at all', []],
    ['an event with no timestamp', [{ newStatus: CONSENT_STATUS.OPTED_OUT, occurredAt: null }]],
    ['an unparseable timestamp', [{ newStatus: CONSENT_STATUS.OPTED_OUT, occurredAt: 'soon' }]],
  ])('records the edit given %s', (_label, events) => {
    expect(isAlreadyRecorded({ events, newStatus: CONSENT_STATUS.OPTED_OUT, now })).toBe(false);
  });
});

describe('reading Meta’s template vocabulary', () => {
  it.each([
    ['APPROVED', TEMPLATE_STATUS.APPROVED],
    ['REJECTED', TEMPLATE_STATUS.REJECTED],
    ['PAUSED', TEMPLATE_STATUS.PAUSED],
    ['IN_APPEAL', TEMPLATE_STATUS.IN_APPEAL],
  ])('maps %s', (meta, expected) => {
    expect(templateStatusFor(meta)).toBe(expected);
  });

  /**
   * Meta has two states for a template on its way out and neither is a state we
   * model. Both mean the same thing to us: unusable.
   */
  it.each(['PENDING_DELETION', 'DELETED'])('treats %s as disabled', (meta) => {
    expect(templateStatusFor(meta)).toBe(TEMPLATE_STATUS.DISABLED);
  });

  /** An unrecognised status must never read as approved. */
  it.each(['SOMETHING_NEW', '', null, undefined])('maps %p to pending', (meta) => {
    expect(templateStatusFor(meta)).toBe(TEMPLATE_STATUS.PENDING);
  });

  it('maps categories and defaults an unknown one to utility', () => {
    expect(templateCategoryFor('MARKETING')).toBe(TEMPLATE_CATEGORY.MARKETING);
    expect(templateCategoryFor('authentication')).toBe(TEMPLATE_CATEGORY.AUTHENTICATION);
    expect(templateCategoryFor('SOMETHING_NEW')).toBe(TEMPLATE_CATEGORY.UTILITY);
  });
});

describe('when a synced template must leave the picker', () => {
  it('keeps an approved, healthy template published', () => {
    expect(shouldUnpublish(TEMPLATE_STATUS.APPROVED, QUALITY.GREEN)).toBe(false);
    expect(shouldUnpublish(TEMPLATE_STATUS.APPROVED, QUALITY.YELLOW)).toBe(false);
    expect(shouldUnpublish(TEMPLATE_STATUS.APPROVED, QUALITY.UNKNOWN)).toBe(false);
  });

  /**
   * Fails closed. A published template that Meta has rejected or paused is a
   * send that fails for every recipient, so anything short of approved
   * withdraws it — and re-publishing is a deliberate human act, never something
   * a later sync undoes.
   */
  it.each([
    TEMPLATE_STATUS.REJECTED,
    TEMPLATE_STATUS.PAUSED,
    TEMPLATE_STATUS.DISABLED,
    TEMPLATE_STATUS.PENDING,
    TEMPLATE_STATUS.IN_APPEAL,
  ])('withdraws a %s template', (status) => {
    expect(shouldUnpublish(status, QUALITY.GREEN)).toBe(true);
  });

  it('withdraws an approved template whose quality went red', () => {
    expect(shouldUnpublish(TEMPLATE_STATUS.APPROVED, QUALITY.RED)).toBe(true);
  });

  /** A pagination bug must not be able to spin a cron forever. */
  it('bounds the page walk', () => {
    expect(MAX_PAGES).toBeGreaterThan(10);
    expect(MAX_PAGES).toBeLessThanOrEqual(100);
  });
});

describe('submitting a template', () => {
  it.each(['proposta_setembro', 'otp_2fa', 'a', 'x_1'])('accepts the name %p', (name) => {
    expect(TEMPLATE_NAME_PATTERN.test(name)).toBe(true);
  });

  it.each(['Proposta', 'com-hifen', 'com espaço', 'acentuação', ''])(
    'refuses the name %p',
    (name) => {
      expect(TEMPLATE_NAME_PATTERN.test(name)).toBe(false);
    },
  );

  /**
   * The single most common first-attempt failure: Meta rejects a submission
   * whose placeholders have no example values, and names neither the component
   * nor the placeholder in the error.
   */
  it('names the component that is missing examples', () => {
    const components: MetaTemplateComponent[] = [
      { type: 'BODY', text: 'Olá {{1}}, da {{2}}' },
    ];

    const gaps = missingExamples(components);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('BODY');
    expect(gaps[0]).toContain('2 placeholder');
  });

  it('accepts a body whose examples are complete', () => {
    expect(
      missingExamples([
        {
          type: 'BODY',
          text: 'Olá {{1}}, da {{2}}',
          example: { body_text: [['Marcos', 'Pixel']] },
        },
      ]),
    ).toEqual([]);
  });

  it('counts a partially exemplified body as missing', () => {
    expect(
      missingExamples([
        { type: 'BODY', text: 'Olá {{1}}, da {{2}}', example: { body_text: [['Marcos']] } },
      ]),
    ).toHaveLength(1);
  });

  it('reads a header’s examples from its own key', () => {
    expect(
      missingExamples([
        { type: 'HEADER', format: 'TEXT', text: 'Proposta {{1}}', example: { header_text: ['Setembro'] } },
      ]),
    ).toEqual([]);

    expect(
      missingExamples([{ type: 'HEADER', format: 'TEXT', text: 'Proposta {{1}}' }]),
    ).toHaveLength(1);
  });

  it('asks nothing of a component with no placeholders', () => {
    expect(missingExamples([{ type: 'BODY', text: 'Bom dia' }])).toEqual([]);
    expect(missingExamples([{ type: 'FOOTER', text: 'Responda SAIR para sair' }])).toEqual([]);
  });

  /**
   * The cap is per WABA per hour, so the key has to carry both — a workspace
   * with two numbers on one business account shares Meta's allowance.
   */
  it('counts submissions per WABA per hour', () => {
    const at = new Date('2026-08-16T14:37:00.000Z');

    expect(submitCountKey('WABA1', at)).toBe('wa:template-submits:WABA1:2026-08-16T14');
    expect(submitCountKey('WABA2', at)).not.toBe(submitCountKey('WABA1', at));
    expect(submitCountKey('WABA1', new Date('2026-08-16T15:00:00.000Z'))).not.toBe(
      submitCountKey('WABA1', at),
    );
  });
});


/**
 * D-47. `components_update` is a **partial** payload: an edit to the body
 * arrives as `message_template_element` on its own. Replacing the stored array
 * with it dropped the template's header, footer and buttons locally — after
 * which the derived spec said there was no header, the support check called it
 * usable, and the next send built a payload Meta answers with 132000 for every
 * recipient.
 */
describe('folding a partial component update into what is stored', () => {
  const stored = [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'Olá {{1}}' },
    { type: 'FOOTER', text: 'Pixel' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Abrir', url: 'https://x/{{1}}' }] },
  ];

  it('keeps the components the update did not mention', () => {
    const changed = componentsFromUpdate({ message_template_element: 'Olá {{1}}, tudo bem?' })!;
    const merged = mergeComponents(stored, changed);

    expect(merged.map((c) => (c as { type: string }).type)).toEqual([
      'HEADER',
      'BODY',
      'FOOTER',
      'BUTTONS',
    ]);
    expect(merged[0]).toEqual({ type: 'HEADER', format: 'IMAGE' });
    expect(merged[1]).toEqual({ type: 'BODY', text: 'Olá {{1}}, tudo bem?' });
  });

  it('replaces the one it does mention, in place', () => {
    const merged = mergeComponents(stored, [{ type: 'FOOTER', text: 'Pixel Infinito' }]);

    expect(merged[2]).toEqual({ type: 'FOOTER', text: 'Pixel Infinito' });
    expect(merged).toHaveLength(4);
  });

  it('appends a component that was not there before', () => {
    const merged = mergeComponents(
      [{ type: 'BODY', text: 'Olá' }],
      [{ type: 'FOOTER', text: 'Pixel' }],
    );

    expect(merged).toEqual([
      { type: 'BODY', text: 'Olá' },
      { type: 'FOOTER', text: 'Pixel' },
    ]);
  });

  it('matches types case-insensitively, as Meta sends them', () => {
    const merged = mergeComponents([{ type: 'body', text: 'antigo' }], [
      { type: 'BODY', text: 'novo' },
    ]);

    expect(merged).toEqual([{ type: 'BODY', text: 'novo' }]);
  });

  it('copes with nothing stored yet', () => {
    expect(mergeComponents(null, [{ type: 'BODY', text: 'Olá' }])).toEqual([
      { type: 'BODY', text: 'Olá' },
    ]);
  });

  /** A header edit still arrives as a title, and must not become a second header. */
  it('does not duplicate a header when the title changes', () => {
    const changed = componentsFromUpdate({ message_template_title: 'Nova manchete' })!;
    const merged = mergeComponents([{ type: 'HEADER', format: 'TEXT', text: 'Antiga' }], changed);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ type: 'HEADER', text: 'Nova manchete' });
  });
});
