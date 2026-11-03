import { defineFrontComponent } from 'twenty-sdk/define';
import { useFrontComponentExecutionContext } from 'twenty-sdk/front-component';

import { ThreadView } from '../components/chat/ThreadView';
import { FC_PERSON_THREAD } from '../constants/universal-identifiers';

/**
 * The WhatsApp tab on a Person record (FR-UI-1).
 *
 * A host, not a component: everything it does is decide *which* conversation
 * `<ThreadView>` should show. Keeping the hosts this thin is what makes the
 * fallback tiers of specs/08 §10 a routing change — if a record widget turns
 * out to be the wrong place for a chat, this file goes away and the side panel
 * renders the identical view.
 *
 * The id it reads is the **Person**, not the thread. The feed resolves the
 * contact's most recent conversation, and answers an empty state rather than a
 * 404 when there is none — a contact who has never messaged is normal, not an
 * error.
 *
 * `useRecordId()` is deprecated, and so is the `recordId` field it reads;
 * `selectedRecordIds` is the current shape. The fallback stays because a record
 * page is not a selection: if a host ever mounts this widget without seeding
 * the selection, the deprecated field is still the one that answers, and a
 * blank chat would be a silent failure.
 */
const WaPersonThread = () => {
  const personId = useFrontComponentExecutionContext((context) =>
    context.selectedRecordIds.length === 1
      ? context.selectedRecordIds[0]
      : (context.recordId ?? null),
  );

  return <ThreadView key={personId} personId={personId} variant="tab" />;
};

export default defineFrontComponent({
  universalIdentifier: FC_PERSON_THREAD,
  name: 'wa-person-thread',
  description: 'The WhatsApp conversation with this contact, on the Person record page.',
  component: WaPersonThread,
});
