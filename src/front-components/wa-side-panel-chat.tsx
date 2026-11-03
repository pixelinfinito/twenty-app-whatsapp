import { defineFrontComponent } from 'twenty-sdk/define';
import { useSelectedRecordIds } from 'twenty-sdk/front-component';

import { ThreadView } from '../components/chat/ThreadView';
import { FC_SIDE_PANEL_CHAT } from '../constants/universal-identifiers';

/**
 * The chat, opened from anywhere a Person is selected (FR-UI-3, specs/08 §7).
 *
 * Reached through the command menu, so the record it is about arrives as a
 * *selection* rather than as the page's record. The command menu item declares
 * `numberOfSelectedRecords === 1`, so the first id is the only id; taking it
 * without that guarantee would open one contact's conversation while the rep
 * was looking at forty.
 */
const WaSidePanelChat = () => {
  const selected = useSelectedRecordIds();

  return <ThreadView key={selected[0] ?? 'empty'} personId={selected[0] ?? null} variant="panel" />;
};

export default defineFrontComponent({
  universalIdentifier: FC_SIDE_PANEL_CHAT,
  name: 'wa-side-panel-chat',
  description: 'The WhatsApp conversation with the selected contact, in the side panel.',
  component: WaSidePanelChat,
});
