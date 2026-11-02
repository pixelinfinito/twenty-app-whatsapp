import { defineLogicFunction } from 'twenty-sdk/define';
import {
  Response,
  type LogicFunctionExecutionContext,
  type RoutePayload,
} from 'twenty-sdk/logic-function';

import { LF_UPLOAD_ROUTE, OBJ_MESSAGE } from '../constants/universal-identifiers';
import { validateOutboundMedia, type OutboundMediaKind } from '../domain/media-limits';
import { authErrorResponse, requireCaller, requireRole } from '../server/auth';
import { metadataClient } from '../server/clients';
import { describeError, logger } from '../server/logger';
import { resolveFieldUniversalIdentifier } from '../server/metadata-ids';

/**
 * `POST /s/whatsapp/upload` — bytes produced *in the page* into Twenty storage.
 *
 * This route exists for bytes the page holds: a `MediaRecorder` recording, or
 * a `File` picked from the device. (It was built for the recorder alone under
 * the belief that a file input exposes only metadata; the D-53 probe measured
 * `FileReader` present and `Blob.arrayBuffer()` working, so the attachment
 * panel now feeds the same door.)
 *
 * The client could not upload them itself. Twenty's `uploadFile` lives on the
 * core GraphQL client, which a front component does not carry a token for, and
 * a multipart upload assembled in the sandbox is a request shape nothing else
 * in this app makes. So the page sends base64 to a route that already has the
 * app's identity, and the route does the upload — one narrow, authenticated
 * door rather than a general one.
 *
 * **It is a door, so it is bounded.** An agent role, a hard byte cap checked
 * *before* decoding, and the same `validateOutboundMedia` limits the sender
 * enforces — because a route that accepted any bytes under any name would be a
 * file host with a WhatsApp app around it.
 */

export type UploadRequestBody = {
  filename?: string;
  contentType?: string;
  /** Base64, without a `data:` prefix — the caller strips it. */
  data?: string;
  mediaKind?: string;
};

/**
 * 8 MB decoded. Comfortably above any voice note a rep will record — a minute
 * of Opus is well under 1 MB — and far below Meta's 16 MB audio ceiling, which
 * leaves room for the base64 inflation and the platform's own body limits.
 * The attachment panel mirrors this cap client-side
 * (`builders/upload.MAX_DEVICE_UPLOAD_BYTES`, held equal by a test) and points
 * larger files at the workspace-URL path instead.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** 4/3 plus padding, which is what base64 costs. */
const MAX_ENCODED_LENGTH = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4;

const UPLOADABLE_KINDS = new Set<OutboundMediaKind>(['audio', 'image', 'video', 'document']);

export const handler = async (
  event: RoutePayload<UploadRequestBody>,
  executionContext: LogicFunctionExecutionContext,
): Promise<Response> => {
  const log = logger.child({ fn: 'wa-upload-route' });

  try {
    const caller = await requireCaller(executionContext);
    requireRole(caller, 'agent');

    const body = event.body ?? {};
    const data = typeof body.data === 'string' ? body.data : '';
    const filename = (body.filename ?? '').trim();
    const contentType = (body.contentType ?? '').trim();
    const mediaKind = (body.mediaKind ?? '') as OutboundMediaKind;

    if (data.length === 0) return new Response({ error: 'data is required' }, { status: 400 });

    /**
     * Length first, bytes second. Decoding to find out something is too large
     * means allocating it — which is the denial-of-service the cap exists to
     * prevent, performed by the check itself.
     */
    if (data.length > MAX_ENCODED_LENGTH) {
      return new Response({ error: 'UPLOAD_TOO_LARGE' }, { status: 413 });
    }

    if (filename.length === 0 || filename.includes('/') || filename.includes('\\')) {
      return new Response({ error: 'a simple filename is required' }, { status: 400 });
    }

    if (!UPLOADABLE_KINDS.has(mediaKind)) {
      return new Response({ error: 'unsupported mediaKind' }, { status: 400 });
    }

    let bytes: Buffer;

    try {
      bytes = Buffer.from(data, 'base64');
    } catch {
      return new Response({ error: 'data is not valid base64' }, { status: 400 });
    }

    if (bytes.byteLength === 0) {
      return new Response({ error: 'data decoded to nothing' }, { status: 400 });
    }

    /**
     * The same gate the sender applies before the Meta upload. Running it here
     * too means a file WhatsApp would refuse never reaches storage at all,
     * rather than being stored, queued, and rejected three steps later.
     */
    const verdict = validateOutboundMedia({
      kind: mediaKind,
      mimeType: contentType,
      sizeBytes: bytes.byteLength,
    });

    if (!verdict.ok) {
      return new Response(
        { error: verdict.reason, detail: verdict.detail },
        { status: 400 },
      );
    }

    /**
     * Asked of the server, not derived. `getFieldUniversalIdentifier` is a
     * build-time helper the logic-function bundler replaces with a stub, so a
     * derived constant is `undefined` here — the same trap the media worker
     * documents, and the reason both go through this resolver.
     */
    const fieldId = await resolveFieldUniversalIdentifier(OBJ_MESSAGE, 'mediaFile');

    if (fieldId === null) {
      log.error('wa.upload.field_unresolved');

      return new Response({ error: 'Internal error' }, { status: 500 });
    }

    /**
     * The **metadata** client, not the core one.
     * `uploadFilesFieldFileByUniversalIdentifier` is only implemented on the
     * metadata endpoint; through the core client it fails with 'Unknown type
     * "Upload"'. The method existing on a client is not evidence its endpoint
     * serves the mutation.
     */
    const uploaded = await metadataClient().uploadFile(
      bytes,
      filename,
      contentType,
      fieldId,
    );

    log.info('wa.upload.stored', { size: uploaded.size });

    return new Response(
      { fileUrl: uploaded.url, filePath: uploaded.path, size: uploaded.size },
      { status: 201 },
    );
  } catch (error) {
    const authFailure = authErrorResponse(error);

    if (authFailure !== null) {
      return new Response(authFailure.body, { status: authFailure.status });
    }

    log.error('wa.upload.failed', describeError(error));

    return new Response({ error: 'Internal error' }, { status: 500 });
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_UPLOAD_ROUTE,
  name: 'wa-upload-route',
  description:
    'Stores bytes produced in the composer — a voice recording — as a Twenty file the send route can attach.',
  timeoutSeconds: 30,
  httpRouteTriggerSettings: {
    path: '/whatsapp/upload',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
