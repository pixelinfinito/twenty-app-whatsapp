import { config } from './config';
import type { AudienceCursor, AudienceDefinition } from '../domain/campaign/audience';
import { translateViewFilters } from '../domain/campaign/view-filter';
import { pageOf, query } from './repositories/base';
import type { PersonRecord } from './repositories/people';
import { fieldsForObject, findView, listViewFilterGroups, listViewFilters } from './repositories/views';

/**
 * Reading an audience, one page at a time (FR-CAM-2, NFR-S4).
 *
 * Three sources with one signature, because the snapshot function must have a
 * single resume path: it stores whatever cursor comes back and hands it to the
 * next self-requeue without knowing which kind of audience it is walking.
 *
 * The page size is 500 — the largest a Core read is worth making — while the
 * *writes* it produces chunk at 60. Reading more per call than we can write in
 * one is deliberate: the read is one request and the writes are the throttled
 * part.
 */

export const AUDIENCE_PAGE_SIZE = 500;

/**
 * The projection an audience page yields.
 *
 * The same shape the people repository returns, because variable resolution
 * reads it through the allow-list and a second, thinner shape would mean the
 * preview and the send resolved from different data.
 */
const PERSON_FIELDS = {
  id: true,
  name: { firstName: true, lastName: true },
  jobTitle: true,
  city: true,
  emails: { primaryEmail: true },
  phones: {
    primaryPhoneNumber: true,
    primaryPhoneCallingCode: true,
    primaryPhoneCountryCode: true,
    additionalPhones: true,
  },
  linkedinLink: { primaryLinkUrl: true },
  whatsappOptInStatus: true,
  whatsappOptInUpdatedAt: true,
  companyId: true,
} as const;

export type AudiencePage = {
  people: PersonRecord[];
  nextCursor: AudienceCursor | null;
};

/**
 * Every number on a Person, primary first.
 *
 * `additionalPhones` is RAW_JSON with no enforced shape: Twenty writes objects
 * (`{ number, callingCode }`), imports have been seen to write bare strings,
 * and a hand-edited record can hold either. All three are read, because the
 * cost of misreading one is a contact excluded as `invalid_phone` who has a
 * perfectly good number in the CRM.
 */
export const personPhones = (
  person: PersonRecord,
): { primary: string | null; additional: string[] } => {
  const phones = person.phones ?? null;
  const code = phones?.primaryPhoneCallingCode ?? '';
  const number = phones?.primaryPhoneNumber ?? '';

  const primary = number.length === 0 ? null : `${code}${number}`;

  const raw = phones?.additionalPhones;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? ((): unknown[] => {
          try {
            const parsed = JSON.parse(raw);

            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];

  const additional = list
    .map((entry) => {
      if (typeof entry === 'string') return entry;

      if (entry !== null && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const entryNumber = typeof record.number === 'string' ? record.number : '';
        const entryCode = typeof record.callingCode === 'string' ? record.callingCode : '';

        return entryNumber.length === 0 ? '' : `${entryCode}${entryNumber}`;
      }

      return '';
    })
    .filter((value) => value.length > 0);

  return { primary, additional };
};

export class AudienceError extends Error {
  readonly reasons: string[];

  constructor(message: string, reasons: string[] = []) {
    super(message);
    this.name = 'AudienceError';
    this.reasons = reasons;
  }
}

/**
 * The Core filter a view means, or a refusal naming every filter it could not
 * translate.
 *
 * Resolved fresh on each page rather than carried in the cursor: a view is
 * five metadata reads, and caching it across a snapshot that runs for
 * seventeen minutes would be caching the definition of who receives a
 * marketing message.
 */
export const resolveViewFilter = async (
  viewId: string,
  now: Date = new Date(),
): Promise<Record<string, unknown> | null> => {
  const view = await findView(viewId);

  if (view === null) {
    throw new AudienceError(`The saved view ${viewId} no longer exists`);
  }

  const [filters, groups, fields] = await Promise.all([
    listViewFilters(viewId),
    listViewFilterGroups(viewId),
    fieldsForObject(view.objectMetadataId),
  ]);

  // Without the zone, "created today" partitions on Angola's midnight while the
  // operator is looking at their own — the audience comes back a little
  // different from the one the view showed (D-44).
  const translated = translateViewFilters({
    filters,
    groups,
    fields,
    now,
    timeZone: config.timeZone(),
  });

  if (!translated.ok) {
    throw new AudienceError(
      `The view "${view.name}" uses filters this app cannot reproduce exactly`,
      translated.reasons,
    );
  }

  return translated.filter;
};

const readPeoplePage = async (
  filter: Record<string, unknown>,
  after: string | null,
  label: string,
): Promise<AudiencePage> => {
  const result = await query(
    (client) =>
      client.query({
        people: {
          __args: {
            filter,
            orderBy: [{ id: 'AscNullsFirst' }],
            first: AUDIENCE_PAGE_SIZE,
            ...(after === null ? {} : { after }),
          },
          edges: { node: PERSON_FIELDS },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    label,
  );

  const page = pageOf<PersonRecord>(result.people);

  return {
    people: page.items,
    nextCursor: page.nextCursor === null ? null : { kind: 'relay', after: page.nextCursor },
  };
};

/**
 * One page of the audience.
 *
 * A view and a message list page through the Core API's own cursor; a manual
 * list pages by offset into the ids the admin chose. The offset form is safe
 * here precisely because the list is immutable — it lives on the campaign
 * record, so no concurrent write can shift the window under a resume.
 */
export const readAudiencePage = async ({
  definition,
  cursor,
  now = new Date(),
}: {
  definition: AudienceDefinition;
  cursor: AudienceCursor | null;
  now?: Date;
}): Promise<AudiencePage> => {
  const after = cursor?.kind === 'relay' ? cursor.after : null;

  switch (definition.kind) {
    case 'view': {
      const filter = await resolveViewFilter(definition.viewId, now);

      return readPeoplePage(filter ?? {}, after, 'audience.viewPage');
    }

    case 'manual': {
      const at = cursor?.kind === 'offset' ? cursor.at : 0;
      const slice = definition.personIds.slice(at, at + AUDIENCE_PAGE_SIZE);

      if (slice.length === 0) return { people: [], nextCursor: null };

      const result = await query(
        (client) =>
          client.query({
            people: {
              __args: { filter: { id: { in: slice } }, first: slice.length },
              edges: { node: PERSON_FIELDS },
            },
          }),
        'audience.manualPage',
      );

      const page = pageOf<PersonRecord>(result.people);
      const nextAt = at + slice.length;

      /**
       * Ordered by the admin's own selection rather than by whatever the API
       * returned. First-occurrence-wins duplicate detection (FR-CAM-3) is only
       * meaningful if "first" means something the person who built the list
       * would recognise.
       */
      const byId = new Map(page.items.map((person) => [person.id, person]));
      const people = slice
        .map((id) => byId.get(id))
        .filter((person): person is PersonRecord => person !== undefined);

      return {
        people,
        nextCursor:
          nextAt >= definition.personIds.length ? null : { kind: 'offset', at: nextAt },
      };
    }

    case 'messageList': {
      const result = await query(
        (client) =>
          client.query({
            messageListMembers: {
              __args: {
                filter: { listId: { eq: definition.messageListId } },
                orderBy: [{ id: 'AscNullsFirst' }],
                first: AUDIENCE_PAGE_SIZE,
                ...(after === null ? {} : { after }),
              },
              edges: { node: { id: true, person: PERSON_FIELDS } },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          }),
        'audience.messageListPage',
      );

      const page = pageOf<{ id: string; person?: PersonRecord | null }>(
        result.messageListMembers,
      );

      return {
        /**
         * A membership row whose person has been deleted is skipped rather
         * than treated as an error: it is an ordinary consequence of deleting
         * a contact, and refusing the whole snapshot over one would make a
         * campaign unbuildable for a reason nobody could see.
         */
        people: page.items
          .map((member) => member.person)
          .filter((person): person is PersonRecord => person !== null && person !== undefined),
        nextCursor:
          page.nextCursor === null ? null : { kind: 'relay', after: page.nextCursor },
      };
    }
  }
};
