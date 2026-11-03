import type { VariableSpec } from './template-spec';

/**
 * Filling `{{n}}` and making the result acceptable to Meta (FR-TPL-3,
 * FR-CAM-4, specs/06 §4).
 *
 * Two audiences, one implementation. The picker renders a live preview as a rep
 * types; `buildSendPayload` builds the wire parameters. If they disagreed, the
 * rep would approve one message and the customer would receive another — so
 * both go through this module, and the validation runs server-side as well as
 * in the browser, because a workflow-driven send has no browser at all.
 *
 * **Index conventions differ by component and this is not an accident**:
 * body variables are 1-based (`{{1}}`, Meta's own numbering) while buttons are
 * 0-based (Meta's `index: "0"` in the payload). Both mirror Meta exactly rather
 * than imposing a house style that would need translating at the boundary.
 */

/**
 * Meta's per-component text limits. A parameter longer than the component it
 * fills is a guaranteed rejection, so values are cut here rather than in the
 * error handler.
 */
export const PARAMETER_LIMITS = {
  HEADER: 60,
  BODY: 1024,
  FOOTER: 60,
  BUTTON_URL: 2000,
} as const;

export type SanitiseOptions = {
  maxLength?: number;
  /** Text gets an ellipsis; a truncated URL suffix must not. */
  ellipsis?: boolean;
};

/**
 * WhatsApp rejects template parameters containing newlines, tabs, or more than
 * four consecutive spaces (the 132000 family). Newlines and tabs become single
 * spaces; longer runs are clipped to four rather than collapsed to one, so a
 * deliberately spaced value keeps as much of its shape as the rule allows.
 */
export const sanitiseParameter = (
  raw: string | null | undefined,
  { maxLength = PARAMETER_LIMITS.BODY, ellipsis = true }: SanitiseOptions = {},
): string => {
  if (typeof raw !== 'string') return '';

  const flattened = raw
    .replace(/[\r\n\t\v\f]+/g, ' ')
    .replace(/ {5,}/g, '    ')
    .trim();

  if (flattened.length <= maxLength) return flattened;

  return ellipsis
    ? `${flattened.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
    : flattened.slice(0, maxLength);
};

export const isBlank = (value: string | null | undefined): boolean =>
  typeof value !== 'string' || value.trim().length === 0;

export type HeaderParameter =
  /**
   * A media header carries either Meta's own id — already uploaded, which a
   * campaign does once for its whole audience — or a handle to the file in
   * Twenty storage for the sender to upload.
   *
   * `fileId` alone is not enough to fetch bytes, which is why `filePath` and
   * `fileUrl` exist beside it: the id names the record, the other two name
   * the content. Carrying only the id would typecheck everywhere and fail at
   * the one moment it mattered.
   */
  | {
      kind: 'media';
      mediaId: string | null;
      fileId: string | null;
      filename?: string | null;
      filePath?: string | null;
      fileUrl?: string | null;
    }
  | { kind: 'text'; values: string[] };

export type ButtonParameter = { index: number; subType: string; value: string };

/**
 * What a send needs, resolved and frozen. Stored verbatim on
 * `whatsappCampaignRecipient.resolvedParameters` at snapshot time so a retry
 * reuses identical content (FR-CAM-9).
 *
 * `body[i]` fills `spec.body.indices[i]` for a positional template and
 * `spec.body.names[i]` for a named one — one ordering rule for both styles,
 * which is only sound because `assessSupport` refuses templates that mix them.
 */
export type ResolvedParameters = {
  header?: HeaderParameter;
  body: string[];
  buttons: ButtonParameter[];
};

export const emptyParameters = (): ResolvedParameters => ({ body: [], buttons: [] });

export type ValidationResult = {
  ok: boolean;
  /** 1-based body positions that resolved empty — the FR-CAM-4 exclusion set. */
  missing: number[];
  /** The same gaps named for a human: `{{2}}`, `{{nome}}`, `header media`. */
  missingKeys: string[];
};

/**
 * Meta rejects a template with an empty parameter, so an unresolved variable is
 * a send that cannot succeed. Detecting it here turns a per-recipient Meta
 * error into a pre-flight exclusion with a reason.
 */
export const validateParameters = (
  spec: VariableSpec,
  parameters: ResolvedParameters,
): ValidationResult => {
  const missing: number[] = [];
  const missingKeys: string[] = [];

  const keys = spec.namedParameters
    ? spec.body.names.map((name) => `{{${name}}}`)
    : spec.body.indices.map((index) => `{{${index}}}`);

  for (let position = 0; position < keys.length; position += 1) {
    if (isBlank(parameters.body[position])) {
      missing.push(position + 1);
      missingKeys.push(keys[position]!);
    }
  }

  const header = spec.header;
  if (header !== null) {
    const isMediaHeader = header.format !== 'TEXT' && header.format !== 'LOCATION';

    if (isMediaHeader) {
      /**
       * Meta's own id, or a handle the sender can fetch bytes with. `fileId`
       * alone names a record without naming its content, so it does not count
       * as supplied — a header that cannot be uploaded is a send that fails
       * for every recipient.
       */
      const supplied =
        parameters.header?.kind === 'media' &&
        (!isBlank(parameters.header.mediaId) ||
          !isBlank(parameters.header.filePath) ||
          !isBlank(parameters.header.fileUrl));

      if (!supplied) missingKeys.push(`header ${header.format.toLowerCase()}`);
    } else if (header.variableCount > 0) {
      const values = parameters.header?.kind === 'text' ? parameters.header.values : [];

      for (let position = 0; position < header.variableCount; position += 1) {
        if (isBlank(values[position])) missingKeys.push(`header {{${position + 1}}}`);
      }
    }
  }

  for (const button of spec.buttons) {
    if (!button.hasVariable) continue;

    const supplied = parameters.buttons.find((candidate) => candidate.index === button.index);
    if (supplied === undefined || isBlank(supplied.value)) {
      missingKeys.push(`button ${button.index}`);
    }
  }

  return { ok: missingKeys.length === 0, missing, missingKeys };
};

/**
 * Substitutes `{{…}}` in template text. Unresolved placeholders are left
 * *visible* rather than blanked: in the picker's live preview an empty gap
 * reads as finished copy, while `{{2}}` reads as work remaining.
 */
export const bindPlaceholders = (
  text: string | null | undefined,
  resolve: (token: string) => string | null,
): string => {
  if (typeof text !== 'string') return '';

  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, token: string) => {
    const value = resolve(token);

    return value === null || value.length === 0 ? whole : value;
  });
};

const bodyResolver =
  (spec: VariableSpec, parameters: ResolvedParameters) =>
  (token: string): string | null => {
    const position = spec.namedParameters
      ? spec.body.names.indexOf(token)
      : spec.body.indices.indexOf(Number(token));

    return position === -1 ? null : (parameters.body[position] ?? null);
  };

/**
 * The rendered body text. Stored on `whatsappMessage.body` for an outbound
 * template send so the thread shows what the customer actually received rather
 * than a template name (FR-TPL-5).
 */
export const renderTemplateBody = (
  spec: VariableSpec,
  parameters: ResolvedParameters,
): string => bindPlaceholders(spec.body.text, bodyResolver(spec, parameters));

export type RenderedTemplate = {
  header: string | null;
  body: string;
  footer: string | null;
  buttons: { index: number; type: string; text: string | null }[];
};

/** The full preview the picker and the campaign builder render (FR-TPL-3). */
export const renderTemplate = (
  spec: VariableSpec,
  parameters: ResolvedParameters,
): RenderedTemplate => {
  const headerValues = parameters.header?.kind === 'text' ? parameters.header.values : [];

  const header =
    spec.header === null || spec.header.format !== 'TEXT'
      ? null
      : bindPlaceholders(spec.header.text, (token) => {
          const position = spec.namedParameters
            ? spec.header!.names.indexOf(token)
            : spec.header!.indices.indexOf(Number(token));

          return position === -1 ? null : (headerValues[position] ?? null);
        });

  return {
    header,
    body: renderTemplateBody(spec, parameters),
    footer: spec.footer?.text ?? null,
    buttons: spec.buttons.map((button) => ({
      index: button.index,
      type: button.type,
      text: button.text,
    })),
  };
};

/**
 * Applies the per-component limits to an already-resolved set. Called once more
 * immediately before the wire payload is built, so a value that reached the
 * record by any route — snapshot, workflow, API — is still within Meta's caps.
 */
export const sanitiseResolvedParameters = (
  parameters: ResolvedParameters,
): ResolvedParameters => ({
  header:
    parameters.header?.kind === 'text'
      ? {
          kind: 'text',
          values: parameters.header.values.map((value) =>
            sanitiseParameter(value, { maxLength: PARAMETER_LIMITS.HEADER }),
          ),
        }
      : parameters.header,
  body: parameters.body.map((value) =>
    sanitiseParameter(value, { maxLength: PARAMETER_LIMITS.BODY }),
  ),
  buttons: parameters.buttons.map((button) => ({
    ...button,
    value: sanitiseParameter(button.value, {
      maxLength: PARAMETER_LIMITS.BUTTON_URL,
      ellipsis: false,
    }),
  })),
});
