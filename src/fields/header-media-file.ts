import { defineField, FieldType } from 'twenty-sdk/define';

export default defineField({
  universalIdentifier: 'f8fbe965-b9d1-48f6-ba60-d57626818508',
  name: 'headerMediaFile',
  label: 'Header media',
  type: FieldType.FILES,
  isNullable: true,
  universalSettings: { maxNumberOfValues: 1 },
  objectUniversalIdentifier: '4ce9aed9-ea3c-44b6-9c32-1f2ea78f1dde',
});
