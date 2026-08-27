import { describe, expect, it } from 'vitest';

import { deriveVariableSpec, type MetaTemplateComponent } from '../template-spec';
import {
  ALLOWED_BINDING_PATHS,
  isAllowedBindingPath,
  resolveBindingPath,
  resolveParameters,
  type ResolutionSubject,
  type VariableMapping,
} from './variable-resolution';

const subject = (overrides: Partial<ResolutionSubject> = {}): ResolutionSubject => ({
  person: {
    id: 'p1',
    name: { firstName: 'Marcos', lastName: 'Lisboa' },
    jobTitle: 'Director',
    city: 'Luanda',
    emails: { primaryEmail: 'marcos@pixel.ao' },
    phones: { primaryPhoneNumber: '923000000', primaryPhoneCallingCode: '+244' },
    linkedinLink: { primaryLinkUrl: 'https://linkedin.com/in/marcos' },
    company: { name: 'Pixel', domainName: { primaryLinkUrl: 'https://pixel.ao' } },
  },
  workspaceMember: { name: { firstName: 'Ana' } },
  account: { displayName: 'Pixel Vendas', defaultCountryCallingCode: '+244' },
  now: new Date('2026-08-15T12:00:00Z'),
  ...overrides,
});

const spec = (components: MetaTemplateComponent[]) => deriveVariableSpec(components);

const body = (text: string): MetaTemplateComponent => ({ type: 'BODY', text });

describe('the allow-list', () => {
  it('is exactly the paths specs/06 §5 permits', () => {
    expect(ALLOWED_BINDING_PATHS).toEqual([
      'person.name.firstName',
      'person.name.lastName',
      'person.jobTitle',
      'person.emails.primaryEmail',
      'person.phones.primaryPhoneNumber',
      'person.city',
      'person.company.name',
      'person.company.domainName',
      'person.linkedinLink.primaryLinkUrl',
      'workspaceMember.name.firstName',
      'account.displayName',
      'now.date',
      'now.month',
      'now.year',
    ]);
  });

  it('resolves every allowed path against a populated subject', () => {
    for (const path of ALLOWED_BINDING_PATHS) {
      expect(resolveBindingPath(path, subject()), path).not.toBeNull();
    }
  });

  /**
   * A binding is admin-authored data that renders into a customer-visible
   * message. There is no traversal code to exploit — this pins that.
   */
  it.each([
    'person.emails',
    'person.__proto__.constructor',
    'constructor.prototype',
    'person.name',
    'person.intro',
    '__proto__',
    'toString',
    '',
  ])('refuses the unlisted path %p', (path) => {
    expect(isAllowedBindingPath(path)).toBe(false);
    expect(resolveBindingPath(path, subject())).toBeNull();
  });

  it('reads composite links whether stored as an object or a bare string', () => {
    expect(resolveBindingPath('person.company.domainName', subject())).toBe('https://pixel.ao');
    expect(
      resolveBindingPath(
        'person.company.domainName',
        subject({ person: { company: { domainName: 'pixel.ao' } } }),
      ),
    ).toBe('pixel.ao');
  });

  /**
   * `phones` is a composite: rendering `primaryPhoneNumber` alone would put a
   * number into a message that nobody outside Angola can dial.
   */
  it('recombines the phone composite into a dialable number', () => {
    expect(resolveBindingPath('person.phones.primaryPhoneNumber', subject())).toBe('+244923000000');
  });

  it('returns null rather than an empty string for missing data', () => {
    expect(resolveBindingPath('person.city', subject({ person: { city: '   ' } }))).toBeNull();
    expect(resolveBindingPath('person.company.name', subject({ person: {} }))).toBeNull();
    expect(resolveBindingPath('person.name.firstName', subject({ person: null }))).toBeNull();
  });

  it('formats dates in Africa/Luanda and pt-PT', () => {
    const s = subject({ now: new Date('2026-08-15T23:30:00Z') });

    // Luanda is UTC+1 year-round, so 23:30Z is already the 16th locally.
    expect(resolveBindingPath('now.date', s)).toBe('16/08/2026');
    expect(resolveBindingPath('now.month', s)).toBe('agosto');
    expect(resolveBindingPath('now.year', s)).toBe('2026');
  });

  /**
   * The reported failure, which is worse than a wrong hour: this date is
   * rendered *into the message the recipient reads*, so an evening campaign
   * from Mexico quoted tomorrow's date back at the customer.
   */
  it('formats dates in the configured zone, not Angola\u2019s', () => {
    const at = new Date('2026-08-15T23:30:00Z');

    expect(resolveBindingPath('now.date', subject({ now: at, timeZone: 'America/Mexico_City' }))).toBe(
      '15/08/2026',
    );
    expect(resolveBindingPath('now.month', subject({ now: at, timeZone: 'America/Mexico_City' }))).toBe(
      'agosto',
    );
  });

  it('keeps the default when the configured zone is unusable', () => {
    const at = new Date('2026-08-15T23:30:00Z');

    expect(resolveBindingPath('now.date', subject({ now: at, timeZone: 'Not/A_Zone' }))).toBe(
      '16/08/2026',
    );
    expect(resolveBindingPath('now.date', subject({ now: at, timeZone: '' }))).toBe('16/08/2026');
  });
});

describe('resolveParameters', () => {
  const twoVars = spec([body('Olá {{1}}, a {{2}} agradece.')]);

  it('resolves field bindings in placeholder order', () => {
    const mapping: VariableMapping = {
      body: [
        { index: 1, kind: 'field', path: 'person.name.firstName' },
        { index: 2, kind: 'field', path: 'person.company.name' },
      ],
    };

    const result = resolveParameters({ spec: twoVars, mapping, subject: subject() });

    expect(result.ok).toBe(true);
    expect(result.parameters.body).toEqual(['Marcos', 'Pixel']);
  });

  it('treats static and manual bindings as literals', () => {
    const mapping: VariableMapping = {
      body: [
        { index: 1, kind: 'static', value: 'Setembro' },
        { index: 2, kind: 'manual', value: 'Pixel' },
      ],
    };

    expect(
      resolveParameters({ spec: twoVars, mapping, subject: subject() }).parameters.body,
    ).toEqual(['Setembro', 'Pixel']);
  });

  it('binds by declared index, not by array order', () => {
    const mapping: VariableMapping = {
      body: [
        { index: 2, kind: 'static', value: 'segundo' },
        { index: 1, kind: 'static', value: 'primeiro' },
      ],
    };

    expect(
      resolveParameters({ spec: twoVars, mapping, subject: subject() }).parameters.body,
    ).toEqual(['primeiro', 'segundo']);
  });

  it('uses the fallback when a field resolves empty (FR-CAM-4)', () => {
    const mapping: VariableMapping = {
      body: [
        { index: 1, kind: 'field', path: 'person.name.firstName', fallback: 'Cliente' },
        { index: 2, kind: 'field', path: 'person.company.name', fallback: 'a nossa equipa' },
      ],
    };

    const result = resolveParameters({
      spec: twoVars,
      mapping,
      subject: subject({ person: { name: { firstName: null } } }),
    });

    expect(result.ok).toBe(true);
    expect(result.parameters.body).toEqual(['Cliente', 'a nossa equipa']);
  });

  it('reports the gaps when a variable resolves empty with no fallback', () => {
    const mapping: VariableMapping = {
      body: [
        { index: 1, kind: 'field', path: 'person.name.firstName' },
        { index: 2, kind: 'field', path: 'person.company.name' },
      ],
    };

    const result = resolveParameters({ spec: twoVars, mapping, subject: subject({ person: {} }) });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ missing: [1, 2], missingKeys: ['{{1}}', '{{2}}'] });
  });

  /**
   * A path that is not on the list must not render as blank text — it is a
   * missing variable, which excludes the recipient visibly.
   */
  it('treats a rejected path as missing rather than empty', () => {
    const mapping: VariableMapping = {
      body: [
        { index: 1, kind: 'field', path: 'person.secretNotes' },
        { index: 2, kind: 'static', value: 'Pixel' },
      ],
    };

    const result = resolveParameters({ spec: twoVars, mapping, subject: subject() });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ missing: [1] });
  });

  it('reports a partial result so the builder can still show a preview', () => {
    const mapping: VariableMapping = {
      body: [
        { index: 1, kind: 'static', value: 'Marcos' },
        { index: 2, kind: 'field', path: 'person.company.name' },
      ],
    };

    const result = resolveParameters({ spec: twoVars, mapping, subject: subject({ person: {} }) });

    expect(result.parameters.body).toEqual(['Marcos', '']);
  });

  it('reports a missing binding for a declared variable', () => {
    expect(resolveParameters({ spec: twoVars, mapping: {}, subject: subject() }).ok).toBe(false);
  });

  it('sanitises resolved values before they reach the wire', () => {
    const mapping: VariableMapping = {
      body: [
        { index: 1, kind: 'static', value: 'Marcos\nLisboa' },
        { index: 2, kind: 'static', value: 'x'.repeat(1200) },
      ],
    };

    const result = resolveParameters({ spec: twoVars, mapping, subject: subject() });

    expect(result.parameters.body[0]).toBe('Marcos Lisboa');
    expect(result.parameters.body[1]).toHaveLength(1024);
  });

  it('resolves named templates by name', () => {
    const named = spec([body('Olá {{nome}}, da {{empresa}}')]);
    const mapping: VariableMapping = {
      body: [
        { index: 1, kind: 'field', path: 'person.name.firstName' },
        { index: 2, kind: 'field', path: 'person.company.name' },
      ],
    };

    const result = resolveParameters({ spec: named, mapping, subject: subject() });

    expect(result.ok).toBe(true);
    expect(result.parameters.body).toEqual(['Marcos', 'Pixel']);
  });

  it('accepts a template with no variables', () => {
    const result = resolveParameters({
      spec: spec([body('Obrigado pelo seu contacto!')]),
      mapping: {},
      subject: subject(),
    });

    expect(result).toEqual({ ok: true, parameters: { header: undefined, body: [], buttons: [] } });
  });
});

describe('headers and buttons', () => {
  it('carries a media header through and flags a missing one', () => {
    const mediaHeader = spec([{ type: 'HEADER', format: 'IMAGE' }, body('Olá')]);

    expect(
      resolveParameters({
        spec: mediaHeader,
        mapping: { header: { kind: 'media', mediaId: '123' } },
        subject: subject(),
      }),
    ).toMatchObject({ ok: true, parameters: { header: { kind: 'media', mediaId: '123' } } });

    expect(
      resolveParameters({ spec: mediaHeader, mapping: {}, subject: subject() }),
    ).toMatchObject({ ok: false, missingKeys: ['header image'] });
  });

  it('resolves a text header variable to its own 60-character limit', () => {
    const textHeader = spec([
      { type: 'HEADER', format: 'TEXT', text: 'Proposta {{1}}' },
      body('Olá'),
    ]);

    const result = resolveParameters({
      spec: textHeader,
      mapping: { header: { kind: 'text', bindings: [{ index: 1, kind: 'static', value: 'x'.repeat(90) }] } },
      subject: subject(),
    });

    expect(result.ok).toBe(true);
    expect(result.parameters.header).toMatchObject({ kind: 'text' });
    expect((result.parameters.header as { values: string[] }).values[0]).toHaveLength(60);
  });

  it('resolves a URL button suffix and leaves variable-free buttons alone', () => {
    const withButtons = spec([
      body('Olá'),
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Ver', url: 'https://x.ao/{{1}}' },
          { type: 'QUICK_REPLY', text: 'Parar' },
        ],
      },
    ]);

    const result = resolveParameters({
      spec: withButtons,
      mapping: { buttons: [{ index: 0, subType: 'url', kind: 'field', path: 'person.id' }] },
      subject: subject(),
    });

    expect(result.ok).toBe(false); // person.id is not on the allow-list
    expect(result.parameters.buttons).toEqual([{ index: 0, subType: 'url', value: '' }]);
  });

  it('fills a button from a static binding', () => {
    const withButtons = spec([
      body('Olá'),
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver', url: 'https://x.ao/{{1}}' }] },
    ]);

    const result = resolveParameters({
      spec: withButtons,
      mapping: { buttons: [{ index: 0, subType: 'url', kind: 'static', value: 'abc123' }] },
      subject: subject(),
    });

    expect(result.ok).toBe(true);
    expect(result.parameters.buttons).toEqual([{ index: 0, subType: 'url', value: 'abc123' }]);
  });
});
