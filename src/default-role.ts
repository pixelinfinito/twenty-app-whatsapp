import { PERMISSION_WHATSAPP_OPERATOR, PERMISSION_WHATSAPP_ADMIN } from './constants/tool-identifiers';
import { SystemPermissionFlag, defineApplicationRole } from 'twenty-sdk/define';

import { APP_DISPLAY_NAME, DEFAULT_ROLE_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

/**
 * The identity the app's own logic functions run as.
 *
 * Scoped down from the scaffolded template: the functions need to write their
 * own objects, read and update Person (contact auto-creation and the consent
 * field), read workspace members, and write timeline activities.
 *
 * Deliberately withheld: `canUpdateAllSettings`.
 *
 * **`canDestroyAllObjectRecords` was withheld and had to be granted.** The
 * reasoning for withholding it was sound — erasure should be an explicit,
 * audited routine rather than something a handler does by accident — but a role
 * is app-wide and cannot tell one handler from another. With the flag off,
 * SEC-8's erasure is a required feature that silently cannot run: the route
 * answered `500` while reporting a correct dry run, because a role setting made
 * to prevent accidental deletion also prevented the deliberate one.
 *
 * So the control moved from the role, where it could not be expressed, to the
 * code, where it can: an architecture test confines every `destroy*` mutation
 * to `server/erasure.ts`. That is a stronger guarantee than the flag gave —
 * it names the module, fails the build, and says why — and unlike the flag it
 * does not break the feature it was protecting.
 *
 * **`UPLOAD_FILE` / `DOWNLOAD_FILE` are granted individually.** The media
 * worker attaches inbound WhatsApp media to `whatsappMessage.mediaFile`, and
 * without them the upload fails with "Entity performing the request does not
 * have permission" — a message that names neither the permission nor the file.
 * Twenty offers these as discrete flags, so the alternative of switching on
 * `canUpdateAllSettings` (which would also hand every handler the data model,
 * roles and billing) was not needed and would have been a poor trade for one
 * file upload.
 *
 * **`ROLES` is granted for the same reason, and it is what makes SEC-5 work at
 * all.** `requireCaller` answers "may this person do this" by reading the role
 * map, and without the flag that read fails with the same opaque sentence —
 * so *every* route answered 403 to *every* real user while working perfectly
 * for an API key, because an API key is a machine caller and never reaches the
 * lookup. Found by probe P-6: the first request this app ever received from a
 * signed-in human was the one that revealed it.
 *
 * It is a read of who holds which role. That is the minimum an app needs to
 * enforce its own permissions, and much less than `canUpdateAllSettings`.
 *
 * **`APPLICATIONS` is granted so the app's own settings are reachable.**
 * `defineSettingsFrontComponent` replaces Twenty's application-variable editor
 * rather than sitting beside it, so the moment this app shipped a settings
 * surface every variable it declares became unchangeable — including the
 * opt-out confirmation wording, which is a variable precisely so that counsel
 * can reword it without a deploy (FR-CON-3). There is no other route to them:
 * `/settings/applications/:id#variables` does not exist.
 *
 * The caller's own token was tried first and does not work — `findOneApplication`
 * is refused with the same token that reads it from the browser, so the platform
 * authorises against the executing application rather than the bearer. The flag
 * is wider than one would like (it covers managing applications generally), and
 * the narrowing that is available is applied instead in code: the route is
 * `admin`-gated, and `setVariable` refuses any key this app did not declare.
 */
export default defineApplicationRole({
  universalIdentifier: DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
  label: `${APP_DISPLAY_NAME} function role`,
  description: `Identity used by ${APP_DISPLAY_NAME} logic functions when reading and writing workspace records`,
  canReadAllObjectRecords: true,
  canUpdateAllObjectRecords: true,
  canSoftDeleteAllObjectRecords: true,
  canDestroyAllObjectRecords: true,
  canUpdateAllSettings: false,
  permissionFlagUniversalIdentifiers: [
    PERMISSION_WHATSAPP_OPERATOR, PERMISSION_WHATSAPP_ADMIN,
    SystemPermissionFlag.UPLOAD_FILE,
    SystemPermissionFlag.DOWNLOAD_FILE,
    SystemPermissionFlag.ROLES,
    SystemPermissionFlag.APPLICATIONS,
  ],
});
