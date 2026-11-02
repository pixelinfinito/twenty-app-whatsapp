import { CoreApiClient, type CoreSchema } from 'twenty-client-sdk/core';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { APPLICATION_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { describe, expect, it } from 'vitest';

import { readAudiencePage } from '../server/audience';
import { createPersonFromWhatsApp, findPersonById } from '../server/repositories/people';

describe('App installation', () => {
  it('should find the installed app in the applications list', async () => {
    const client = new MetadataApiClient();

    const result = await client.query({
      findManyApplications: {
        id: true,
        name: true,
        universalIdentifier: true,
      },
    });

    const app = result.findManyApplications.find(
      (a: { universalIdentifier: string }) =>
        a.universalIdentifier === APPLICATION_UNIVERSAL_IDENTIFIER,
    );

    expect(app).toBeDefined();
  });
});

describe('CoreApiClient', () => {
  it('should support CRUD on standard objects', async () => {
    const client = new CoreApiClient();

    const created = await client.mutation({
      createNote: {
        __args: { data: { title: 'Integration test note' } },
        id: true,
      },
    });
    const noteId = created.createNote?.id;
    expect(noteId).toBeDefined();

    await client.mutation({
      destroyNote: {
        __args: { id: noteId as string },
        id: true,
      },
    });
  });
});

describe('Twenty 2.53 contact compatibility', () => {
  it('creates a contact and reads typed additional phones through contact and audience queries', async () => {
    const client = new CoreApiClient();
    const person = await createPersonFromWhatsApp({
      firstName: 'WhatsApp', lastName: 'Compatibility test',
      nationalNumber: '923000001', callingCode: '+244', countryCode: 'AO',
    });

    try {
      const additional = [{ number: '923000002', callingCode: '+244', countryCode: 'AO' }];
      await client.mutation({ updatePerson: {
        __args: { id: person.id, data: { phones: { additionalPhones: additional as unknown as CoreSchema.PhonesUpdateInput['additionalPhones'] } } },
        id: true,
      } });

      expect((await findPersonById(person.id))?.phones?.additionalPhones).toEqual(additional);
      const audience = await readAudiencePage({
        definition: { kind: 'manual', personIds: [person.id], capturedAt: new Date().toISOString() },
        cursor: null,
      });
      expect(audience.people[0]?.phones?.additionalPhones).toEqual(additional);
      expect(person.whatsappOptInStatus).toBe('UNKNOWN');
    } finally {
      await client.mutation({ destroyPerson: { __args: { id: person.id }, id: true } });
    }
  });
});
