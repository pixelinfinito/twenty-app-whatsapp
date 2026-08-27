import { DEFAULT_TIME_ZONE, resolveTimeZone } from '../time-zone';

/**
 * Translating a saved Twenty view into a Core API filter (FR-CAM-2a).
 *
 * A view is metadata: rows of `viewFilter` referring to `fieldMetadata` ids,
 * nested inside `viewFilterGroup`s that carry the logical operator. The Core
 * API does not accept any of that — it accepts a `PersonFilterInput`. So this
 * module is the translation, and it is pure so that every operand can be
 * asserted without a server.
 *
 * **It refuses rather than approximates.** An audience is who receives a
 * marketing message, and a filter we translate *nearly* correctly sends to
 * people the admin did not choose — a mistake that is invisible in review,
 * irreversible on send, and indistinguishable from working. So every
 * (field type, operand) pair is either translated exactly or named as
 * untranslatable, and a view containing one untranslatable filter fails the
 * whole build with a message saying which filter and why.
 */

export const VIEW_FILTER_OPERAND = {
  IS: 'IS',
  IS_NOT: 'IS_NOT',
  IS_NOT_NULL: 'IS_NOT_NULL',
  LESS_THAN_OR_EQUAL: 'LESS_THAN_OR_EQUAL',
  GREATER_THAN_OR_EQUAL: 'GREATER_THAN_OR_EQUAL',
  IS_BEFORE: 'IS_BEFORE',
  IS_AFTER: 'IS_AFTER',
  CONTAINS: 'CONTAINS',
  DOES_NOT_CONTAIN: 'DOES_NOT_CONTAIN',
  IS_EMPTY: 'IS_EMPTY',
  IS_NOT_EMPTY: 'IS_NOT_EMPTY',
  IS_RELATIVE: 'IS_RELATIVE',
  IS_IN_PAST: 'IS_IN_PAST',
  IS_IN_FUTURE: 'IS_IN_FUTURE',
  IS_TODAY: 'IS_TODAY',
  VECTOR_SEARCH: 'VECTOR_SEARCH',
} as const;
export type ViewFilterOperand =
  (typeof VIEW_FILTER_OPERAND)[keyof typeof VIEW_FILTER_OPERAND];

export type ViewFilterRow = {
  id: string;
  fieldMetadataId: string;
  operand: string;
  /**
   * Typed `JSON` in the metadata schema, which in practice means "a string
   * that is usually JSON": a select filter arrives as `'["OPTED_IN"]'`, a text
   * filter as the raw text, and either may already be parsed by the transport.
   */
  value: unknown;
  viewFilterGroupId?: string | null;
  positionInViewFilterGroup?: number | null;
  subFieldName?: string | null;
};

export type ViewFilterGroupRow = {
  id: string;
  logicalOperator: string;
  parentViewFilterGroupId?: string | null;
  positionInViewFilterGroup?: number | null;
};

export type FieldDescriptor = {
  /** The Core API field name — `jobTitle`, `whatsappOptInStatus`. */
  name: string;
  /** The `FieldMetadataType` string, e.g. `TEXT`, `SELECT`, `DATE_TIME`. */
  type: string;
};

export type CoreFilter = Record<string, unknown>;

export type TranslationSuccess = { ok: true; filter: CoreFilter | null };
export type TranslationFailure = { ok: false; reasons: string[] };
export type Translation = TranslationSuccess | TranslationFailure;

/**
 * Composite fields, and which sub-fields a bare filter searches.
 *
 * A filter on `name` with no `subFieldName` means "either name", which is what
 * the Twenty UI shows and therefore what the admin chose. Translating it to
 * `firstName` alone would silently halve an audience.
 */
const COMPOSITE_SUBFIELDS: Record<string, string[]> = {
  FULL_NAME: ['firstName', 'lastName'],
  EMAILS: ['primaryEmail'],
  PHONES: ['primaryPhoneNumber'],
  LINKS: ['primaryLinkUrl', 'primaryLinkLabel'],
};

const TEXT_TYPES = new Set(['TEXT', 'FULL_NAME', 'EMAILS', 'PHONES', 'LINKS']);
const NUMBER_TYPES = new Set(['NUMBER', 'NUMERIC', 'POSITION']);
const DATE_TYPES = new Set(['DATE', 'DATE_TIME']);
const SELECT_TYPES = new Set(['SELECT']);
const MULTI_SELECT_TYPES = new Set(['MULTI_SELECT']);
const BOOLEAN_TYPES = new Set(['BOOLEAN']);
const UUID_TYPES = new Set(['UUID', 'RELATION']);

/** `%` and `_` are wildcards in `ilike`; a literal search must escape them. */
export const escapeLike = (value: string): string =>
  value.replace(/[\\%_]/g, (character) => `\\${character}`);

/**
 * A stored view value, as whatever it actually is.
 *
 * Select filters store `'["OPTED_IN","UNKNOWN"]'`; text filters store the raw
 * string, which may itself begin with `[`. Parsing is therefore attempted and
 * the failure is not an error — it means the value was a plain string all
 * along.
 */
export const parseValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (trimmed.length === 0) return '';

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
};

const asStringList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === 'string' || typeof entry === 'number')
      .map((entry) => String(entry));
  }

  return typeof value === 'string' && value.length > 0 ? [value] : [];
};

/**
 * How far the campaign time zone is from UTC at a given instant.
 *
 * Read from `Intl` rather than hard-coded, so the day boundary stays right if
 * the zone is ever changed to one that observes daylight saving.
 */
const zoneOffsetMs = (at: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTimeZone(timeZone),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const field = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const local = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour') % 24,
    field('minute'),
    field('second'),
  );

  return local - Math.floor(at.getTime() / 1000) * 1000;
};

/**
 * Midnight **in the campaign's time zone**, expressed as an instant.
 *
 * A day filter used to be expanded against UTC midnight while every date the
 * campaign *renders* uses the configured zone — so "created today" meant
 * 01:00 to 01:00 local, and a contact added at half past midnight fell into
 * yesterday's audience (D-44). One hour of skew for Angola, more elsewhere,
 * and invisible either way: the audience simply comes back a little different
 * from the one the admin saw in the view.
 */
const startOfDay = (at: Date, timeZone: string): Date => {
  const shifted = new Date(at.getTime() + zoneOffsetMs(at, timeZone));
  const localMidnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );

  return new Date(localMidnight - zoneOffsetMs(new Date(localMidnight), timeZone));
};

const addDays = (at: Date, days: number): Date =>
  new Date(at.getTime() + days * 86_400_000);

/**
 * One `viewFilter` row as a Core filter fragment.
 *
 * Returns a string when it cannot be translated; the caller collects those and
 * refuses the whole view. Every branch is exhaustive over the operands the
 * platform can produce for that field type — an unhandled combination is a
 * refusal, never a silently dropped condition, because a dropped condition
 * *widens* the audience.
 */
export const translateFilter = ({
  filter,
  field,
  now,
  timeZone = DEFAULT_TIME_ZONE,
}: {
  filter: ViewFilterRow;
  field: FieldDescriptor;
  now: Date;
  /** The zone the day filters partition on — see `startOfDay`. */
  timeZone?: string;
}): CoreFilter | string => {
  const operand = filter.operand.toUpperCase() as ViewFilterOperand;
  const value = parseValue(filter.value);
  const where = `${field.name} (${field.type}) ${operand}`;

  if (operand === VIEW_FILTER_OPERAND.VECTOR_SEARCH) {
    return `${where}: a full-text search cannot define an audience — its results change with the index`;
  }

  if (operand === VIEW_FILTER_OPERAND.IS_RELATIVE) {
    return `${where}: relative date ranges are not translated — use an absolute date, or a manual audience`;
  }

  /**
   * Composite fields address a sub-field; a bare filter fans out across the
   * ones the UI searches. `subFieldName` is honoured when the view sets it,
   * which is what a filter built on "First name" specifically produces.
   */
  const subFields =
    COMPOSITE_SUBFIELDS[field.type] === undefined
      ? null
      : typeof filter.subFieldName === 'string' && filter.subFieldName.length > 0
        ? [filter.subFieldName]
        : COMPOSITE_SUBFIELDS[field.type]!;

  const wrap = (comparator: CoreFilter): CoreFilter => {
    if (subFields === null) return { [field.name]: comparator };

    if (subFields.length === 1) {
      return { [field.name]: { [subFields[0]!]: comparator } };
    }

    return { or: subFields.map((sub) => ({ [field.name]: { [sub]: comparator } })) };
  };

  const negate = (comparator: CoreFilter): CoreFilter => ({ not: wrap(comparator) });

  if (TEXT_TYPES.has(field.type)) {
    const text = typeof value === 'string' ? value : asStringList(value).join(' ');

    switch (operand) {
      case VIEW_FILTER_OPERAND.CONTAINS:
        return wrap({ ilike: `%${escapeLike(text)}%` });
      case VIEW_FILTER_OPERAND.DOES_NOT_CONTAIN:
        return negate({ ilike: `%${escapeLike(text)}%` });
      case VIEW_FILTER_OPERAND.IS:
        return wrap({ eq: text });
      case VIEW_FILTER_OPERAND.IS_NOT:
        return negate({ eq: text });
      /**
       * "Empty" means null *or* the empty string. Twenty writes `''` into a
       * cleared text column rather than null, so a null-only test would report
       * a blank field as filled and put it in the audience.
       */
      case VIEW_FILTER_OPERAND.IS_EMPTY:
        return { or: [wrap({ is: 'NULL' }), wrap({ eq: '' })] };
      case VIEW_FILTER_OPERAND.IS_NOT_EMPTY:
      case VIEW_FILTER_OPERAND.IS_NOT_NULL:
        return { and: [wrap({ is: 'NOT_NULL' }), wrap({ neq: '' })] };
      default:
        return `${where}: unsupported operand for a text field`;
    }
  }

  if (SELECT_TYPES.has(field.type)) {
    const options = asStringList(value);

    switch (operand) {
      case VIEW_FILTER_OPERAND.IS:
        return options.length === 0
          ? `${where}: no options selected`
          : wrap({ in: options });
      case VIEW_FILTER_OPERAND.IS_NOT:
        return options.length === 0
          ? `${where}: no options selected`
          : negate({ in: options });
      case VIEW_FILTER_OPERAND.IS_EMPTY:
        return wrap({ is: 'NULL' });
      case VIEW_FILTER_OPERAND.IS_NOT_EMPTY:
      case VIEW_FILTER_OPERAND.IS_NOT_NULL:
        return wrap({ is: 'NOT_NULL' });
      default:
        return `${where}: unsupported operand for a select field`;
    }
  }

  if (MULTI_SELECT_TYPES.has(field.type)) {
    const options = asStringList(value);

    switch (operand) {
      case VIEW_FILTER_OPERAND.IS:
        return options.length === 0
          ? `${where}: no options selected`
          : wrap({ containsAny: options });
      case VIEW_FILTER_OPERAND.IS_NOT:
        return options.length === 0
          ? `${where}: no options selected`
          : negate({ containsAny: options });
      case VIEW_FILTER_OPERAND.IS_EMPTY:
        return { or: [wrap({ is: 'NULL' }), wrap({ isEmptyArray: true })] };
      case VIEW_FILTER_OPERAND.IS_NOT_EMPTY:
      case VIEW_FILTER_OPERAND.IS_NOT_NULL:
        return { and: [wrap({ is: 'NOT_NULL' }), wrap({ isEmptyArray: false })] };
      default:
        return `${where}: unsupported operand for a multi-select field`;
    }
  }

  if (BOOLEAN_TYPES.has(field.type)) {
    const truthy = value === true || value === 'true' || value === 1 || value === '1';

    switch (operand) {
      case VIEW_FILTER_OPERAND.IS:
        return wrap({ eq: truthy });
      case VIEW_FILTER_OPERAND.IS_NOT:
        return wrap({ eq: !truthy });
      default:
        return `${where}: unsupported operand for a boolean field`;
    }
  }

  if (NUMBER_TYPES.has(field.type)) {
    /**
     * `Number(null)` and `Number('')` are both **0**, a perfectly finite number
     * — so a numeric filter with no value used to translate into `= 0` and
     * quietly select a different set of people (D-35). Blank is refused before
     * the conversion, not after it.
     */
    const blank =
      value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

    const numeric = blank ? Number.NaN : Number(typeof value === 'string' ? value : (value as number));

    if (
      !Number.isFinite(numeric) &&
      operand !== VIEW_FILTER_OPERAND.IS_EMPTY &&
      operand !== VIEW_FILTER_OPERAND.IS_NOT_EMPTY &&
      operand !== VIEW_FILTER_OPERAND.IS_NOT_NULL
    ) {
      return `${where}: value "${String(filter.value)}" is not a number`;
    }

    switch (operand) {
      case VIEW_FILTER_OPERAND.IS:
        return wrap({ eq: numeric });
      case VIEW_FILTER_OPERAND.IS_NOT:
        return wrap({ neq: numeric });
      case VIEW_FILTER_OPERAND.GREATER_THAN_OR_EQUAL:
        return wrap({ gte: numeric });
      case VIEW_FILTER_OPERAND.LESS_THAN_OR_EQUAL:
        return wrap({ lte: numeric });
      case VIEW_FILTER_OPERAND.IS_EMPTY:
        return wrap({ is: 'NULL' });
      case VIEW_FILTER_OPERAND.IS_NOT_EMPTY:
      case VIEW_FILTER_OPERAND.IS_NOT_NULL:
        return wrap({ is: 'NOT_NULL' });
      default:
        return `${where}: unsupported operand for a number field`;
    }
  }

  if (DATE_TYPES.has(field.type)) {
    const parsed = typeof value === 'string' ? new Date(value) : null;
    const valid = parsed !== null && !Number.isNaN(parsed.getTime());

    switch (operand) {
      case VIEW_FILTER_OPERAND.IS_BEFORE:
        return valid ? wrap({ lt: parsed!.toISOString() }) : `${where}: invalid date`;
      case VIEW_FILTER_OPERAND.IS_AFTER:
        return valid ? wrap({ gt: parsed!.toISOString() }) : `${where}: invalid date`;
      /**
       * "Is" on a date means the whole day, not the instant. A column storing
       * 14:32 would never equal a filter written as midnight, so an exact
       * comparison would produce an empty audience and look like a data
       * problem.
       */
      case VIEW_FILTER_OPERAND.IS: {
        if (!valid) return `${where}: invalid date`;

        const from = startOfDay(parsed!, timeZone);

        return wrap({ gte: from.toISOString(), lt: addDays(from, 1).toISOString() });
      }
      case VIEW_FILTER_OPERAND.IS_TODAY: {
        const from = startOfDay(now, timeZone);

        return wrap({ gte: from.toISOString(), lt: addDays(from, 1).toISOString() });
      }
      case VIEW_FILTER_OPERAND.IS_IN_PAST:
        return wrap({ lt: now.toISOString() });
      case VIEW_FILTER_OPERAND.IS_IN_FUTURE:
        return wrap({ gt: now.toISOString() });
      case VIEW_FILTER_OPERAND.IS_EMPTY:
        return wrap({ is: 'NULL' });
      case VIEW_FILTER_OPERAND.IS_NOT_EMPTY:
      case VIEW_FILTER_OPERAND.IS_NOT_NULL:
        return wrap({ is: 'NOT_NULL' });
      default:
        return `${where}: unsupported operand for a date field`;
    }
  }

  if (UUID_TYPES.has(field.type)) {
    const ids = asStringList(value);

    switch (operand) {
      case VIEW_FILTER_OPERAND.IS:
        return ids.length === 0 ? `${where}: no records selected` : wrap({ in: ids });
      case VIEW_FILTER_OPERAND.IS_NOT:
        return ids.length === 0 ? `${where}: no records selected` : negate({ in: ids });
      case VIEW_FILTER_OPERAND.IS_EMPTY:
        return wrap({ is: 'NULL' });
      case VIEW_FILTER_OPERAND.IS_NOT_EMPTY:
      case VIEW_FILTER_OPERAND.IS_NOT_NULL:
        return wrap({ is: 'NOT_NULL' });
      default:
        return `${where}: unsupported operand for a relation field`;
    }
  }

  return `${where}: this field type cannot be translated into an audience filter`;
};

const combine = (operator: string, parts: CoreFilter[]): CoreFilter | null => {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;

  return operator.toUpperCase() === 'OR' ? { or: parts } : { and: parts };
};

/**
 * A whole view: every filter, nested by group, as one Core filter.
 *
 * Groups form a tree — Twenty allows one level of nesting in the UI but the
 * model is recursive — so the walk is recursive too, with a depth cap that
 * makes a cyclic `parentViewFilterGroupId` a refusal rather than a hang.
 */
export const translateViewFilters = ({
  filters,
  groups,
  fields,
  now = new Date(),
  maxDepth = 10,
  timeZone = DEFAULT_TIME_ZONE,
}: {
  filters: ViewFilterRow[];
  groups: ViewFilterGroupRow[];
  /** Field metadata id → the Core field it names. */
  fields: Map<string, FieldDescriptor>;
  now?: Date;
  maxDepth?: number;
  /**
   * The zone "created today" partitions on. Defaulted so existing callers keep
   * Angola's day boundary; `server/audience.ts` passes `config.timeZone()` so
   * the audience matches the operator's today rather than the server's.
   */
  timeZone?: string;
}): Translation => {
  const reasons: string[] = [];

  const byPosition = <T extends { positionInViewFilterGroup?: number | null }>(
    items: T[],
  ): T[] =>
    [...items].sort(
      (left, right) =>
        (left.positionInViewFilterGroup ?? 0) - (right.positionInViewFilterGroup ?? 0),
    );

  const visitedGroups = new Set<string>();
  const visitedFilters = new Set<string>();

  const build = (groupId: string | null, depth: number): CoreFilter | null => {
    if (groupId !== null) visitedGroups.add(groupId);

    if (depth > maxDepth) {
      reasons.push('the view filter groups nest too deeply, or refer to each other');

      return null;
    }

    const group = groupId === null ? null : groups.find((entry) => entry.id === groupId);
    const operator = group?.logicalOperator ?? 'AND';

    const own = byPosition(
      filters.filter((filter) => (filter.viewFilterGroupId ?? null) === groupId),
    );

    const parts: CoreFilter[] = [];

    for (const filter of own) {
      visitedFilters.add(filter.id);

      const field = fields.get(filter.fieldMetadataId);

      if (field === undefined) {
        reasons.push(
          `a filter refers to a field this app cannot see (${filter.fieldMetadataId})`,
        );
        continue;
      }

      const translated = translateFilter({ filter, field, now, timeZone });

      if (typeof translated === 'string') {
        reasons.push(translated);
        continue;
      }

      parts.push(translated);
    }

    for (const child of byPosition(
      groups.filter((entry) => (entry.parentViewFilterGroupId ?? null) === groupId),
    )) {
      const nested = build(child.id, depth + 1);

      if (nested !== null) parts.push(nested);
    }

    /**
     * `NOT` is a group operator in the metadata but never appears in the UI's
     * filter builder. Treating it as `AND` would invert the audience, so it is
     * refused by name.
     */
    if (operator.toUpperCase() === 'NOT') {
      reasons.push('a NOT filter group cannot be translated into an audience filter');

      return null;
    }

    return combine(operator, parts);
  };

  const filter = build(null, 0);

  /**
   * Everything the view holds must have been *reached*.
   *
   * The walk descends from the root through `parentViewFilterGroupId`, so a
   * filter pointing at a group that no longer exists — or a group whose parent
   * chain is broken or circular — was never visited and simply vanished from
   * the translation. A dropped condition **widens** an audience, which is the
   * one failure mode this module exists to prevent, and it left no trace at all
   * (D-40).
   */
  const orphanFilters = filters.filter((entry) => !visitedFilters.has(entry.id));
  const orphanGroups = groups.filter((entry) => !visitedGroups.has(entry.id));

  if (orphanFilters.length > 0) {
    reasons.push(
      `${orphanFilters.length} filter(s) in this view sit in a group that cannot be reached from the top level`,
    );
  }

  if (orphanGroups.length > 0) {
    reasons.push(
      `${orphanGroups.length} filter group(s) in this view cannot be reached from the top level`,
    );
  }

  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, filter };
};
