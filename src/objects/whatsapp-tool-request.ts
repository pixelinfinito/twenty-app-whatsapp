import { defineObject, FieldType } from 'twenty-sdk/define';
import { OBJ_TOOL_REQUEST } from '../constants/tool-identifiers';

export default defineObject({
  universalIdentifier: OBJ_TOOL_REQUEST,
  nameSingular: 'whatsappToolRequest', namePlural: 'whatsappToolRequests',
  labelSingular: 'WhatsApp tool request', labelPlural: 'WhatsApp tool requests',
  icon: 'IconLock', isUICreatable: false, isUIEditable: false,
  labelIdentifierFieldMetadataUniversalIdentifier: '73968eab-ab02-4f43-b334-00c4dd6c415d',
  fields: [
    { universalIdentifier: '73968eab-ab02-4f43-b334-00c4dd6c415d', name: 'name', label: 'Name', type: FieldType.TEXT, isNullable: false, defaultValue: "''" },
    { universalIdentifier: 'd3e32b99-f548-4e30-9c4d-11e769bf2e46', name: 'requestKey', label: 'Request key', type: FieldType.TEXT, isNullable: true, isUnique: true },
    { universalIdentifier: 'e42609ec-b064-4d61-bd95-8c68a55a1732', name: 'fingerprint', label: 'Fingerprint', type: FieldType.TEXT, isNullable: false, defaultValue: "''" },
    { universalIdentifier: '279194ff-cbb2-4be3-8018-5a61892e804e', name: 'state', label: 'State', type: FieldType.TEXT, isNullable: false, defaultValue: "''" },
    { universalIdentifier: '519487cf-a96f-4dad-834f-a7de423e1467', name: 'result', label: 'Result', type: FieldType.RAW_JSON, isNullable: true },
  ],
});
