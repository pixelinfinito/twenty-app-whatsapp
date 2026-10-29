import { toE164 } from '../phone/normalise';
import { resolveTimeZone } from '../time-zone';
import {
  PARAMETER_LIMITS,
  isBlank,
  sanitiseParameter,
  type ResolvedParameters,
} from '../template-render';
import type { VariableSpec } from '../template-spec';

/**
 * Campaign and template variable binding (FR-CAM-4, specs/06 §5, specs/07 §4).
 *
 * A binding is admin-authored data that renders into a customer-visible
 * message, so resolution is a lookup in a fixed table of allowed paths — never
 * a property walk over a dotted string. There is no traversal code here at all:
 * an unknown path cannot reach the record because there is nothing to traverse
 * with. Extending the list is a code change with a test, deliberately.
 */

export type PersonProjection = {
  id?: string | null;
  name?: { firstName?: string | null; lastName?: string | null } | null;
  jobTitle?: string | null;
  city?: string | null;
  emails?: { primaryEmail?: string | null } | null;
  phones?: {
    primaryPhoneNumber?: string | null;
    primaryPhoneCallingCode?: string | null;
  } | null;
  linkedinLink?: { primaryLinkUrl?: string | null } | null;
  company?: {
    name?: string | null;
    domainName?: { primaryLinkUrl?: string | null } | string | null;
  } | null;
};

export type ResolutionSubject = {
  person?: PersonProjection | null;
  workspaceMember?: { name?: { firstName?: string | null } | null } | null;
  account?: { displayName?: string | null; defaultCountryCallingCode?: string | null } | null;
  now: Date;
  /**
   * The zone `now.*` renders in. Travels with `now` because it is the other
   * half of the same fact: an instant without a zone is not yet a date, and
   * these three bindings put a date into a message the customer reads.
   *
   * Optional and defaulted so every existing caller keeps its behaviour; the
   * callers that have configuration (`wa-campaign-snapshot`, `wa-campaign-
   * control`) pass `config.timeZone()`.
   */
  timeZone?: string;
};

const LOCALE = 'pt-PT';

/**
 * Angola has no DST, but naming the zone keeps a server in any region honest —
 * and now that the zone is configurable, naming it is what makes a campaign
 * sent from Mexico render Mexico's date rather than Angola's in the recipient's
 * own message.
 */
const formatNow = (subject: ResolutionSubject, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(LOCALE, {
    timeZone: resolveTimeZone(subject.timeZone),
    ...options,
  }).format(subject.now);

const linkUrl = (value: { primaryLinkUrl?: string | null } | string | null | undefined): string | null => {
  if (typeof value === 'string') return value;

  return value?.primaryLinkUrl ?? null;
};

/**
 * `phones` is a composite: the national number and its calling code are stored
 * apart. Rendering `primaryPhoneNumber` alone would put a number into a message
 * that nobody outside the country can dial, so the two are recombined.
 */
const primaryPhone = (person: PersonProjection | null | undefined, fallbackCode: string): string | null => {
  const number = person?.phones?.primaryPhoneNumber;
  if (isBlank(number)) return null;

  const code = person?.phones?.primaryPhoneCallingCode;

  return toE164(`${code ?? ''}${number}`, code ?? fallbackCode) ?? `${code ?? ''}${number}`.trim();
};

type Resolver = (subject: ResolutionSubject) => string | null;

/**
 * The allow-list (specs/06 §5). Order is the order the field picker shows.
 */
const RESOLVERS: Record<string, Resolver> = {
  'person.name.firstName': (s) => s.person?.name?.firstName ?? null,
  'person.name.lastName': (s) => s.person?.name?.lastName ?? null,
  'person.jobTitle': (s) => s.person?.jobTitle ?? null,
  'person.emails.primaryEmail': (s) => s.person?.emails?.primaryEmail ?? null,
  'person.phones.primaryPhoneNumber': (s) =>
    primaryPhone(s.person, s.account?.defaultCountryCallingCode ?? '+244'),
  'person.city': (s) => s.person?.city ?? null,
  'person.company.name': (s) => s.person?.company?.name ?? null,
  'person.company.domainName': (s) => linkUrl(s.person?.company?.domainName),
  'person.linkedinLink.primaryLinkUrl': (s) => linkUrl(s.person?.linkedinLink),
  'workspaceMember.name.firstName': (s) => s.workspaceMember?.name?.firstName ?? null,
  'account.displayName': (s) => s.account?.displayName ?? null,
  'now.date': (s) => formatNow(s, { day: '2-digit', month: '2-digit', year: 'numeric' }),
  'now.month': (s) => formatNow(s, { month: 'long' }),
  'now.year': (s) => formatNow(s, { year: 'numeric' }),
};

export const ALLOWED_BINDING_PATHS = Object.keys(RESOLVERS);

export const isAllowedBindingPath = (path: string): boolean =>
  Object.prototype.hasOwnProperty.call(RESOLVERS, path);

/**
 * A single value from the allow-list, or null. Null covers three cases the
 * caller must treat identically — absent data, an empty string, and a path that
 * is not on the list — because all three mean "we cannot fill this variable",
 * and a rejected path must never quietly render as blank text.
 */
export const resolveBindingPath = (
  path: string,
  subject: ResolutionSubject,
): string | null => {
  const resolver = isAllowedBindingPath(path) ? RESOLVERS[path] : undefined;
  if (resolver === undefined) return null;

  const value = resolver(subject);

  return isBlank(value) ? null : value!.trim();
};

export type VariableBinding = {
  /** 1-based for body variables, matching `{{1}}`. */
  index: number;
  /**
   * `field` reads the allow-list; `static` and `manual` are both literals —
   * they differ only in whether the builder offers the value for reuse.
   */
  kind: 'field' | 'static' | 'manual';
  path?: string;
  value?: string | null;
  fallback?: string | null;
};

export type ButtonBinding = VariableBinding & {
  /** 0-based, matching Meta's own button `index`. */
  index: number;
  subType: string;
};

export type VariableMapping = {
  header?:
    | {
        kind: 'media';
        mediaId?: string | null;
        fileId?: string | null;
        filePath?: string | null;
        fileUrl?: string | null;
      }
    | { kind: 'text'; bindings: VariableBinding[] };
  body?: VariableBinding[];
  buttons?: ButtonBinding[];
};

const resolveBinding = (
  binding: VariableBinding | undefined,
  subject: ResolutionSubject,
): string | null => {
  if (binding === undefined) return null;

  const raw =
    binding.kind === 'field'
      ? binding.path === undefined
        ? null
        : resolveBindingPath(binding.path, subject)
      : (binding.value ?? null);

  if (!isBlank(raw)) return raw!.trim();

  // FR-CAM-4: an empty resolution is not an error while a fallback exists.
  return isBlank(binding.fallback) ? null : binding.fallback!.trim();
};

export type ResolutionSuccess = { ok: true; parameters: ResolvedParameters };

export type ResolutionFailure = {
  ok: false;
  /** 1-based body positions that could not be filled (FR-CAM-4). */
  missing: number[];
  missingKeys: string[];
  /** What *did* resolve, so the builder can show the rep the partial preview. */
  parameters: ResolvedParameters;
};

const byIndex = (bindings: VariableBinding[] | undefined, index: number) =>
  (bindings ?? []).find((binding) => binding.index === index);

/**
 * Resolve every variable a template needs for one recipient.
 *
 * Called at snapshot time and the result frozen onto the recipient row: a send
 * or a retry reuses it verbatim, so editing a Person mid-campaign cannot change
 * what a half-sent campaign says (FR-CAM-2).
 */
export const resolveParameters = ({
  spec,
  mapping,
  subject,
}: {
  spec: VariableSpec;
  mapping: VariableMapping;
  subject: ResolutionSubject;
}): ResolutionSuccess | ResolutionFailure => {
  const missing: number[] = [];
  const missingKeys: string[] = [];

  // Body variables are addressed by `{{n}}` for positional templates and by
  // name for named ones; the resulting array is positional either way, matching
  // `ResolvedParameters.body`'s contract.
  const bodyKeys = spec.namedParameters
    ? spec.body.names.map((name, position) => ({ key: `{{${name}}}`, index: position + 1 }))
    : spec.body.indices.map((index) => ({ key: `{{${index}}}`, index }));

  const body = bodyKeys.map(({ key, index }, position) => {
    const value = resolveBinding(byIndex(mapping.body, index), subject);

    if (value === null) {
      missing.push(position + 1);
      missingKeys.push(key);

      return '';
    }

    return sanitiseParameter(value, { maxLength: PARAMETER_LIMITS.BODY });
  });

  const header = ((): ResolvedParameters['header'] => {
    if (spec.header === null) return undefined;

    if (spec.header.format !== 'TEXT') {
      if (mapping.header?.kind !== 'media') {
        missingKeys.push(`header ${spec.header.format.toLowerCase()}`);
        return undefined;
      }

      const {
        mediaId = null,
        fileId = null,
        filePath = null,
        fileUrl = null,
      } = mapping.header;

      /**
       * Any one of these is enough: Meta's id needs no upload, and either
       * storage handle lets the sender perform one. A header with only a
       * record id and no way to reach its bytes is a missing variable, not a
       * resolved one.
       */
      if (isBlank(mediaId) && isBlank(filePath) && isBlank(fileUrl)) {
        missingKeys.push(`header ${spec.header.format.toLowerCase()}`);
      }

      return { kind: 'media', mediaId, fileId, filePath, fileUrl };
    }

    if (spec.header.variableCount === 0) return undefined;

    const bindings = mapping.header?.kind === 'text' ? mapping.header.bindings : [];

    const values = Array.from({ length: spec.header.variableCount }, (_unused, position) => {
      const value = resolveBinding(byIndex(bindings, position + 1), subject);

      if (value === null) {
        missingKeys.push(`header {{${position + 1}}}`);
        return '';
      }

      return sanitiseParameter(value, { maxLength: PARAMETER_LIMITS.HEADER });
    });

    return { kind: 'text', values };
  })();

  const buttons = spec.buttons
    .filter((button) => button.hasVariable)
    .map((button) => {
      const binding = (mapping.buttons ?? []).find(
        (candidate) => candidate.index === button.index,
      );
      const value = resolveBinding(binding, subject);

      if (value === null) missingKeys.push(`button ${button.index}`);

      return {
        index: button.index,
        subType: (binding?.subType ?? button.type).toLowerCase(),
        value:
          value === null
            ? ''
            : sanitiseParameter(value, {
                maxLength: PARAMETER_LIMITS.BUTTON_URL,
                ellipsis: false,
              }),
      };
    });

  const parameters: ResolvedParameters = { header, body, buttons };

  return missingKeys.length === 0
    ? { ok: true, parameters }
    : { ok: false, missing, missingKeys, parameters };
};
