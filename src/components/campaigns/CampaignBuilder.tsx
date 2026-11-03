import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { VariableBinding, VariableMapping } from '../../domain/campaign/variable-resolution';
import type { AccountProjection } from '../../domain/feed/projection';
import {
  buttonVariableHints,
  headerVariableHints,
  mediaHeaderOf,
} from '../../domain/template-hints';
import { emptyParameters, renderTemplate } from '../../domain/template-render';
import type { VariableSpec } from '../../domain/template-spec';
import { isWorkspaceFileAddress } from '../../domain/workspace-file';
import type { FeedTemplate } from '../common/use-feed';
import { useCopy, type Translate } from '../common/copy';
import { browserDateTime, displayPhone } from '../common/format';
import { Glyph } from '../common/icons';
import { ActionButton, Banner, Card, Field, useInputStyle } from '../common/ui';
import { useCampaignActions } from './campaign-actions';
import { FileUpload } from '../chat/builders/FileUpload';
import type { SelectedFile } from '../chat/builders/upload';
import { mediaKindForHeaderFormat } from '../../domain/media-limits';

/**
 * The five-step builder (FR-CAM-1, specs/07 §2).
 *
 * **Every step from the second one persists.** Each "Continuar" writes the
 * draft through `create`/`update` before advancing, so a reload — or a widget
 * the host remounts, which happens — never loses work. Holding five steps of
 * state in a component and writing it once at the end is how a sandbox that
 * "can fail, often silently" costs someone an afternoon.
 *
 * The record cannot exist before step 2: `create` requires a template, because
 * a campaign without one has nothing to say and no cost to estimate. So step 1
 * is the only one held in memory, and it is two fields.
 *
 * **The audience is a choice between three shapes**, not a free-text box. Views
 * come from the server's own list, filtered to the types that are actually
 * lists of people; a UUID field would let an admin point a campaign at a record
 * page layout.
 *
 * **Variables bind to an allow-list.** `bindingPaths` is `ALLOWED_BINDING_PATHS`
 * from the resolver itself, so the dropdown cannot offer a path the snapshot
 * will refuse — and a rejected path renders as blank text, which Meta answers
 * with 132000 for every recipient.
 *
 * **Nothing is decided without seeing it.** A message preview rides along from
 * the template step onwards, and it gets more real as the builder learns more:
 * the bare template first, then the template with this campaign's own bindings
 * standing in, and finally — on Review — the text a named contact from the
 * actual audience is going to receive, rendered by the server with the same
 * function the snapshot uses.
 */

export type CampaignBuilderProps = {
  fieldMetadataId?: string | null;
  accounts: AccountProjection[];
  templates: FeedTemplate[];
  /**
   * A campaign record to reopen, or null to start a new one (D-61).
   *
   * A draft used to be a one-way door: the builder wrote one on every step and
   * the detail screen could show it, but nothing led back in — so an
   * interrupted campaign was work that could only be deleted and redone. The
   * record carries everything the form holds, so reopening is a matter of
   * reading it rather than of storing anything new.
   */
  resume?: Record<string, unknown> | null;
  onDone: (campaignId: string) => void;
  onCancel: () => void;
};

type AudienceKind = 'view' | 'manual';

const STEPS = [
  'campaign.step.basics',
  'campaign.step.template',
  'campaign.step.audience',
  'campaign.step.variables',
  'campaign.step.review',
] as const;

const REVIEW_STEP = STEPS.length - 1;

/** Enough to be representative, few enough to read. */
const PREVIEW_SAMPLE = 5;

type Binding = { kind: 'field' | 'static'; path: string; value: string; fallback: string };

type PreviewRow = {
  personId: string | null;
  name: string | null;
  phone: string | null;
  ok: boolean;
  missing: string[];
  rendered: { header: string | null; body: string; footer: string | null };
};

const specOf = (template: FeedTemplate | undefined): VariableSpec | null =>
  template?.variableSpec === null || template?.variableSpec === undefined
    ? null
    : (template.variableSpec as unknown as VariableSpec);

/**
 * The last segment of a binding path, as a stand-in value.
 *
 * `person.name.firstName` reads as `«firstName»` in the preview. Not a real
 * value and not pretending to be one — the guillemets are there so nobody
 * mistakes it for the contact's actual name — but it puts the *shape* of the
 * finished sentence on screen while the mapping is still being edited, which
 * `{{1}}` never did.
 */
export const standIn = (binding: Binding): string => {
  if (binding.kind === 'static') {
    return binding.value.length > 0 ? binding.value : binding.fallback;
  }

  const leaf = binding.path
    .split('.')
    .filter((part) => part.length > 0)
    .pop();

  return leaf === undefined ? '' : `«${leaf}»`;
};

/** A binding row in the shape `resolveParameters` reads. */
const bindingOf = (binding: Binding | undefined, index: number): VariableBinding => {
  const row = binding ?? { kind: 'field' as const, path: '', value: '', fallback: '' };

  return {
    index,
    kind: row.kind,
    ...(row.kind === 'field' ? { path: row.path } : { value: row.value }),
    ...(row.fallback === '' ? {} : { fallback: row.fallback }),
  };
};

/**
 * Everything the campaign has to say about the template's variables (D-59).
 *
 * It used to say `{ body }` and nothing else, while `resolveParameters` reads a
 * header and buttons too. A template with either was therefore buildable,
 * launchable, and excluded every recipient for "missing variables" — a
 * campaign that could not have sent a single message, with nothing on any
 * screen explaining why. The two shapes are now the same shape, and this is
 * pure and exported so a test can hold them together.
 *
 * The index conventions are Meta's and differ by component: body variables are
 * 1-based, buttons are 0-based. Neither is normalised, because the resolver
 * matches on them.
 */
export const buildVariableMapping = ({
  spec,
  bindings,
  headerBindings,
  headerFileUrl,
  headerFile,
  buttonBindings,
}: {
  spec: VariableSpec | null;
  bindings: Binding[];
  headerBindings: Binding[];
  headerFileUrl: string;
  headerFile?: SelectedFile | null;
  buttonBindings: Record<number, Binding>;
}): VariableMapping => {
  const mediaHeader = mediaHeaderOf(spec);
  const headerHints = headerVariableHints(spec);
  const buttonHints = buttonVariableHints(spec);

  return {
    body: bindings.map((binding, index) =>
      bindingOf(
        binding,
        spec?.namedParameters === true ? index + 1 : (spec?.body.indices[index] ?? index + 1),
      ),
    ),
    /**
     * A media header is resolved once for the campaign rather than per
     * recipient: the sender uploads the file to Meta and every recipient reuses
     * the id. A text header binds per recipient, exactly like the body.
     *
     * An address that is not a workspace file is carried as null rather than
     * as itself — the resolver would accept the string and the send would fail
     * for the whole audience (D-58).
     */
    ...(mediaHeader !== null
      ? {
          header: {
            kind: 'media' as const,
            ...(headerFile
              ? {
                  fileId: headerFile.fileId,
                  filePath: headerFile.path,
                  filename: headerFile.filename,
                }
              : { fileUrl: isWorkspaceFileAddress(headerFileUrl) ? headerFileUrl.trim() : null }),
          },
        }
      : headerHints.length === 0
        ? {}
        : {
            header: {
              kind: 'text' as const,
              bindings: headerBindings.map((binding, index) => bindingOf(binding, index + 1)),
            },
          }),
    ...(buttonHints.length === 0
      ? {}
      : {
          buttons: buttonHints.map((button) => ({
            ...bindingOf(buttonBindings[button.index], button.index),
            subType: button.subType,
          })),
        }),
  };
};

/** A stored binding read back into the row shape the form edits. */
const rowOf = (binding: VariableBinding | undefined): Binding => ({
  kind: binding?.kind === 'field' ? 'field' : 'static',
  path: binding?.path ?? '',
  value: binding?.value ?? '',
  fallback: binding?.fallback ?? '',
});

/**
 * `buildVariableMapping` read backwards, so a draft can be reopened (D-61).
 *
 * A draft could be created and then only *looked at*: the detail screen had no
 * way back into the builder, so an interrupted campaign was abandoned work with
 * a record beside it. Reopening is only useful if the form comes back filled,
 * which means reading the stored mapping — and reading it by index rather than
 * by position, because that is how it was written and a template edited in
 * between could have changed the order.
 */
export const bindingsFromMapping = (
  spec: VariableSpec | null,
  mapping: VariableMapping | null,
): {
  bindings: Binding[];
  headerBindings: Binding[];
  headerFileUrl: string;
  buttonBindings: Record<number, Binding>;
} => {
  const body = mapping?.body ?? [];
  const header = mapping?.header ?? null;

  const bodyIndices =
    spec === null
      ? []
      : spec.namedParameters
        ? spec.body.names.map((_unused, position) => position + 1)
        : spec.body.indices;

  return {
    bindings: bodyIndices.map((index) => rowOf(body.find((row) => row.index === index))),
    headerBindings:
      header?.kind === 'text'
        ? headerVariableHints(spec).map((_unused, position) =>
            rowOf(header.bindings.find((row) => row.index === position + 1)),
          )
        : [],
    headerFileUrl: header?.kind === 'media' ? (header.fileUrl ?? '') : '',
    buttonBindings: Object.fromEntries(
      buttonVariableHints(spec).map((button) => [
        button.index,
        rowOf((mapping?.buttons ?? []).find((row) => row.index === button.index)),
      ]),
    ),
  };
};

export type OpenedCampaign = {
  campaignId: string | null;
  step: number;
  name: string;
  accountId: string;
  scheduledAt: string;
  templateId: string;
  audienceKind: AudienceKind;
  viewId: string;
  personIds: string[];
  bindings: Binding[];
  headerBindings: Binding[];
  headerFileUrl: string;
  buttonBindings: Record<number, Binding>;
};

const EMPTY_OPENED: OpenedCampaign = {
  campaignId: null,
  step: 0,
  name: '',
  accountId: '',
  scheduledAt: '',
  templateId: '',
  audienceKind: 'view',
  viewId: '',
  personIds: [],
  bindings: [],
  headerBindings: [],
  headerFileUrl: '',
  buttonBindings: {},
};

/** One contact in the manual-audience picker: enough to recognise, no more. */
type PickedPerson = { id: string; name: string | null; phone: string | null };

/** "Maria Silva · +244 923 000 111" — the phone is the disambiguator. */
const pickedLabel = (person: PickedPerson): string => {
  const parts = [person.name, displayPhone(person.phone)].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );

  return parts.length === 0 ? person.id : parts.join(' · ');
};

/**
 * A stored campaign, read back into the form's initial state (D-61).
 *
 * **The step it opens on is the furthest one already answered**, not the first.
 * A draft abandoned at the variables screen that reopened on "Basics" would ask
 * an operator to press Continue past three screens they had already filled in
 * — which is a resume in name only.
 *
 * Pure and exported: it is the inverse of five screens of writes, and the kind
 * of mapping that is wrong in one field for a long time before anybody notices.
 */
export const openedFrom = (
  campaign: Record<string, unknown> | null | undefined,
  templates: FeedTemplate[],
): OpenedCampaign => {
  if (campaign === null || campaign === undefined) return EMPTY_OPENED;

  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const audience = (campaign.audienceDefinition ?? null) as {
    kind?: string;
    viewId?: string;
    personIds?: string[];
  } | null;

  const templateId = text(campaign.templateId);
  const spec = specOf(templates.find((candidate) => candidate.id === templateId));

  const name = text(campaign.name);
  const accountId = text(campaign.accountId);
  const hasAudience =
    audience?.kind === 'view'
      ? text(audience.viewId).length > 0
      : (audience?.personIds ?? []).length > 0;

  return {
    ...EMPTY_OPENED,
    campaignId: text(campaign.id) === '' ? null : text(campaign.id),
    step: hasAudience ? 3 : templateId !== '' ? 2 : name !== '' && accountId !== '' ? 1 : 0,
    name,
    accountId,
    /**
     * `datetime-local` reads `YYYY-MM-DDTHH:mm` and nothing else; the stored
     * value is a full ISO instant, and handing it over whole leaves the field
     * empty — which reads as "not scheduled" for a campaign that is.
     */
    scheduledAt: browserDateTime(text(campaign.scheduledAt)),
    templateId,
    audienceKind: audience?.kind === 'manual' ? 'manual' : 'view',
    viewId: text(audience?.viewId),
    personIds: (audience?.personIds ?? []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    ),
    ...bindingsFromMapping(spec, (campaign.variableMapping ?? null) as VariableMapping | null),
  };
};

/**
 * What is wrong with the sending number, before anybody launches anything.
 *
 * Pure and exported: it is four independent conditions, three of them
 * survivable and one of them fatal, and getting "this campaign will not start"
 * confused with "this campaign is worth a second look" is the kind of thing a
 * test should hold still.
 */
export const accountWarnings = (account: AccountProjection | null): string[] => {
  if (account === null) return ['campaign.warnNotConnected'];

  return [
    account.status === 'CONNECTED' ? null : 'campaign.warnNotConnected',
    account.qualityRating === 'RED' ? 'campaign.warnQualityRed' : null,
    account.qualityRating === 'YELLOW' ? 'campaign.warnQualityYellow' : null,
    account.isTestAccount ? 'campaign.warnTestAccount' : null,
  ].filter((key): key is string => key !== null);
};

/** The dashed box every preview in this app renders into. */
const Preview = ({
  rendered,
  note,
  t,
}: {
  rendered: { header: string | null; body: string; footer: string | null };
  note?: string;
  t: Translate;
}) => {
  const theme = useTheme();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.spacing[1],
          fontSize: theme.font.size.sm,
          fontWeight: theme.font.weight.medium,
          color: theme.font.color.secondary,
        }}
      >
        <Glyph name="template" />
        {t('campaign.previewTitle')}
      </span>

      <div
        style={{
          border: `1px dashed ${theme.border.color.medium}`,
          borderRadius: theme.border.radius.sm,
          padding: theme.spacing[2],
          fontSize: theme.font.size.md,
          whiteSpace: 'pre-wrap',
          color: theme.font.color.secondary,
        }}
      >
        {rendered.header === null ? null : (
          <div style={{ fontWeight: theme.font.weight.semiBold }}>{rendered.header}</div>
        )}
        <div>{rendered.body}</div>
        {rendered.footer === null ? null : (
          <div style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
            {rendered.footer}
          </div>
        )}
      </div>

      {note === undefined ? null : (
        <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
          {note}
        </span>
      )}
    </div>
  );
};

const SummaryRow = ({ label, value }: { label: string; value: string }) => {
  const theme = useTheme();

  return (
    <div style={{ display: 'flex', gap: theme.spacing[2], flexWrap: 'wrap' }}>
      <span
        style={{
          flex: '0 0 160px',
          fontSize: theme.font.size.sm,
          color: theme.font.color.secondary,
        }}
      >
        {label}
      </span>
      <span
        style={{
          flex: '1 1 200px',
          fontSize: theme.font.size.md,
          color: theme.font.color.primary,
        }}
      >
        {value}
      </span>
    </div>
  );
};

export const CampaignBuilder = ({
  fieldMetadataId,
  accounts,
  templates,
  resume = null,
  onDone,
  onCancel,
}: CampaignBuilderProps) => {
  const theme = useTheme();
  const input = useInputStyle();
  const { t } = useCopy();
  const { call } = useCampaignActions();

  /**
   * What the record was when this builder opened.
   *
   * Read once, into the initial state of each field, and never watched: a
   * reopened draft is edited here and written back on every step, so a poll
   * arriving mid-edit must not reach in and replace what somebody is typing.
   * `useState`'s initialiser is the whole mechanism — there is no effect to
   * fight with (D-61).
   */
  const opened = useMemo(() => openedFrom(resume, templates), [resume, templates]);

  const [step, setStep] = useState(opened.step);
  const [campaignId, setCampaignId] = useState<string | null>(opened.campaignId);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(opened.name);
  const [accountId, setAccountId] = useState(opened.accountId || (accounts[0]?.id ?? ''));
  const [scheduledAt, setScheduledAt] = useState(opened.scheduledAt);
  const [templateId, setTemplateId] = useState(opened.templateId);
  const [audienceKind, setAudienceKind] = useState<AudienceKind>(opened.audienceKind);
  const [viewId, setViewId] = useState(opened.viewId);
  /**
   * The manual audience, as people rather than a textarea of UUIDs.
   *
   * A reopened draft starts with ids only; the hydration effect below fills the
   * names in. Keeping the id as the row's identity means a contact the search
   * can no longer find (deleted, renamed) still shows *as its id* instead of
   * silently disappearing from the audience.
   */
  const [selectedPeople, setSelectedPeople] = useState<PickedPerson[]>(
    opened.personIds.map((id) => ({ id, name: null, phone: null })),
  );
  const [personQuery, setPersonQuery] = useState('');
  const [personResults, setPersonResults] = useState<PickedPerson[]>([]);
  const [personSearching, setPersonSearching] = useState(false);
  const [personSearchError, setPersonSearchError] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [bindings, setBindings] = useState<Binding[]>(opened.bindings);
  /**
   * The rest of the template, which this builder used to ignore (D-59).
   *
   * `variableMapping` carried only `body`, so a template with a header or a
   * dynamic button was launchable and then excluded every recipient for
   * "missing variables" — the resolver counts those components, and nothing
   * here ever supplied them. A media header is one file for the whole audience;
   * a text header and a button value bind per recipient like any body variable.
   */
  const [headerBindings, setHeaderBindings] = useState<Binding[]>(opened.headerBindings);
  const [headerFileUrl, setHeaderFileUrl] = useState(opened.headerFileUrl);
  const [headerFile, setHeaderFile] = useState<SelectedFile | null>(() => {
    const mapping = resume?.variableMapping as VariableMapping | undefined;
    const header = mapping?.header;
    const files = resume?.headerMediaFile as
      { fileId: string; label: string; url?: string }[] | undefined;
    if (header?.kind !== 'media' || !header.fileId || !header.filePath) return null;
    return {
      fileId: header.fileId,
      path: header.filePath,
      url: files?.[0]?.url ?? '',
      filename: header.filename ?? files?.[0]?.label ?? 'Header media',
      size: 0,
      mimeType: '',
      mediaKind:
        mediaKindForHeaderFormat(
          mediaHeaderOf(specOf(templates.find((entry) => entry.id === opened.templateId)))?.format,
        ) ?? 'document',
    };
  });
  const [buttonBindings, setButtonBindings] = useState<Record<number, Binding>>(
    opened.buttonBindings,
  );

  const [optionsError, setOptionsError] = useState(false);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [views, setViews] = useState<{ id: string; name: string }[]>([]);
  const [paths, setPaths] = useState<string[]>([]);
  const [sample, setSample] = useState<PreviewRow[] | null>(null);
  const [sampleError, setSampleError] = useState(false);
  const sampleRequest = useRef(0);
  useEffect(() => () => { sampleRequest.current += 1; }, []);
  const scheduleValid = scheduledAt === '' || (Number.isFinite(Date.parse(scheduledAt)) && Date.parse(scheduledAt) > Date.now());

  /**
   * Campaigns may only use marketing and utility templates. Authentication ones
   * are OTP-shaped — a one-time code sent to a list is either meaningless or a
   * security incident — so they are excluded here and refused again at launch.
   */
  const usable = useMemo(
    () =>
      templates.filter(
        (template) => template.category === 'MARKETING' || template.category === 'UTILITY',
      ),
    [templates],
  );

  const template = usable.find((candidate) => candidate.id === templateId);
  const spec = specOf(template);
  const account = accounts.find((candidate) => candidate.id === accountId) ?? null;

  const labels = useMemo(() => {
    if (spec === null) return [];

    return spec.namedParameters
      ? spec.body.names.map((n) => `{{${n}}}`)
      : spec.body.indices.map((i) => `{{${i}}}`);
  }, [spec]);

  const headerHints = useMemo(() => headerVariableHints(spec), [spec]);
  const mediaHeader = useMemo(() => mediaHeaderOf(spec), [spec]);
  const buttonHints = useMemo(() => buttonVariableHints(spec), [spec]);

  const headerFileValid = headerFile !== null || isWorkspaceFileAddress(headerFileUrl);

  /** Whether the variables step has anything at all to ask for. */
  const hasVariables =
    labels.length > 0 || headerHints.length > 0 || mediaHeader !== null || buttonHints.length > 0;

  useEffect(() => {
    let active = true;
    setOptionsError(false);
    void call<{ views: { id: string; name: string }[]; bindingPaths: string[] }>(
      'audienceOptions',
    ).then((result) => {
      if (!active) return;
      setOptionsError(!result.ok);
      if (result.ok) {
        setViews(result.data.views);
        setPaths(result.data.bindingPaths);
      }
    });
    return () => { active = false; };
  }, [call, optionsAttempt]);

  /**
   * A reopened draft stored ids; the picker owes the operator names. One read,
   * merged by id so a contact the server no longer returns keeps its row (and
   * its id as the label) rather than silently leaving the audience.
   */
  useEffect(() => {
    if (opened.personIds.length === 0) return;

    void call<{ people: PickedPerson[] }>('personSearch', {
      personIds: opened.personIds,
    }).then((result) => {
      if (!result.ok) return;

      setSelectedPeople((current) =>
        current.map((row) => {
          const found = result.data.people.find((person) => person.id === row.id);

          return found === undefined ? row : { ...row, name: found.name, phone: found.phone };
        }),
      );
    });
  }, [call, opened]);

  /**
   * The search itself, debounced. 300 ms is enough to collapse a typed word
   * into one request without the picker feeling like it is waiting.
   */
  useEffect(() => {
    const term = personQuery.trim();
    let active = true;
    setPersonSearchError(false);
    setPersonResults([]);

    if (term.length < 2) {
      setPersonResults([]);
      setPersonSearching(false);

      return;
    }

    setPersonSearching(true);

    const timer = setTimeout(() => {
      void call<{ people: PickedPerson[] }>('personSearch', { query: term }).then((result) => {
        if (!active) return;
        setPersonSearching(false);
        setPersonSearchError(!result.ok);
        if (result.ok) setPersonResults(result.data.people);
      });
    }, 300);

    return () => { active = false; clearTimeout(timer); };
  }, [call, personQuery, searchAttempt]);

  // One binding row per placeholder, kept in step with the chosen template.
  useEffect(() => {
    const blank = (): Binding => ({
      kind: 'field',
      path: paths[0] ?? '',
      value: '',
      fallback: '',
    });

    setBindings((current) => labels.map((_, index) => current[index] ?? blank()));
    setHeaderBindings((current) => headerHints.map((_, index) => current[index] ?? blank()));
    setButtonBindings((current) =>
      Object.fromEntries(
        buttonHints.map((button) => [button.index, current[button.index] ?? blank()]),
      ),
    );
  }, [labels, headerHints, buttonHints, paths]);

  const audienceDefinition = useMemo(() => {
    if (audienceKind === 'view') return viewId === '' ? null : { kind: 'view', viewId };

    return selectedPeople.length === 0
      ? null
      : { kind: 'manual', personIds: selectedPeople.map((person) => person.id) };
  }, [audienceKind, selectedPeople, viewId]);

  const variableMapping = useMemo(
    () =>
      buildVariableMapping({
        spec,
        bindings,
        headerBindings,
        headerFileUrl,
        headerFile,
        buttonBindings,
      }),
    [bindings, spec, headerFileUrl, headerFile, headerBindings, buttonBindings],
  );

  /** The template as it stands, with whatever the mapping can stand in for. */
  const localPreview = useMemo(
    () =>
      spec === null
        ? null
        : renderTemplate(spec, {
            ...emptyParameters(),
            body: bindings.map(standIn),
            // A text header's placeholders stand in too, so the preview stops
            // showing `{{1}}` in the one line a reader looks at first.
            ...(headerHints.length === 0
              ? {}
              : { header: { kind: 'text' as const, values: headerBindings.map(standIn) } }),
          }),
    [bindings, headerBindings, headerHints, spec],
  );

  const persist = useCallback(
    async (patch: Record<string, unknown>): Promise<string | null> => {
      if (saving.current) return null;
      saving.current = true;
      setBusy(true);
      setError(null);

      const result =
        campaignId === null
          ? await call<{ campaign?: { id?: string } }>('create', patch)
          : await call('update', { campaignId, ...patch });

      saving.current = false;
      setBusy(false);

      if (!result.ok) {
        setError(result.error);

        return null;
      }

      if (campaignId === null) {
        const created = result.data as { campaign?: { id?: string } };
        const id = created.campaign?.id ?? null;

        if (id === null) {
          setError(t('campaign.createdNoId'));

          return null;
        }

        setCampaignId(id);
        return id;
      }

      return campaignId;
    },
    [call, campaignId, t],
  );

  /**
   * The real thing, rendered by the server against real contacts.
   *
   * Asked for once, on arriving at Review, and only after the mapping has been
   * written — `preview` reads the campaign record, so calling it before the
   * save would render the *previous* mapping and quietly show the wrong text
   * on the one screen whose whole job is to be right.
   */
  const loadSample = useCallback(
    async (id: string) => {
      const request = ++sampleRequest.current;
      setSampleError(false);
      const result = await call<{ rows: PreviewRow[] }>('preview', {
        campaignId: id,
        sampleSize: PREVIEW_SAMPLE,
      });

      if (request !== sampleRequest.current) return;
      setSampleError(!result.ok);
      setSample(result.ok ? result.data.rows : []);
    },
    [call],
  );

  const next = useCallback(async () => {
    if (saving.current) return;
    if (!scheduleValid) { setError(t('campaign.scheduleInvalid')); return; }
    // Step 0 is not written: `create` needs the template that step 1 chooses.
    if (step === 0) {
      setStep(1);

      return;
    }

    const patches: Record<number, Record<string, unknown>> = {
      1: {
        name,
        accountId,
        templateId,
        scheduledAt: scheduledAt === '' ? null : new Date(scheduledAt).toISOString(),
      },
      2: { audienceDefinition },
      3: { variableMapping },
    };

    if (!(await persist(patches[step]))) return;

    setStep((current) => current + 1);

    // Entering Review: the mapping is saved, so the sample will be current.
    if (step === 3 && campaignId !== null) {
      setSample(null);
      void loadSample(campaignId);
    }
  }, [
    accountId,
    audienceDefinition,
    campaignId,
    loadSample,
    name,
    persist,
    scheduledAt,
    scheduleValid,
    t,
    step,
    templateId,
    variableMapping,
  ]);

  const build = useCallback(async () => {
    if (campaignId === null || saving.current) return;
    saving.current = true;
    setError(null);
    setBusy(true);

    const result = await call('build', { campaignId });

    saving.current = false;
    setBusy(false);

    if (!result.ok) {
      setError(result.error);

      return;
    }

    onDone(campaignId);
  }, [call, campaignId, onDone]);

  const saveDraft = async () => {
    if (!scheduleValid) { setError(t('campaign.scheduleInvalid')); return; }
    const id = await persist({
      name, accountId, templateId, audienceDefinition, variableMapping,
      scheduledAt: scheduledAt === '' ? null : new Date(scheduledAt).toISOString(),
    });
    if (id) onDone(id);
  };

  const canAdvance =
    step === 0
      ? name.trim().length > 0 && accountId !== '' && scheduleValid
      : step === 1
        ? templateId !== ''
        : step === 2
          ? audienceDefinition !== null
          : /**
             * A media header is the one variable the builder can settle here,
             * because it is one file for the whole audience rather than a
             * per-recipient lookup. Advancing without it produces a campaign
             * that excludes everyone, which is a worse way to learn the same
             * thing (D-59).
             */
            step !== 3 || mediaHeader === null || headerFileValid;

  /**
   * One binding row, for a body variable, a text header or a dynamic button.
   *
   * A closure rather than a component so it keeps `input`, `paths` and `t`
   * without threading them through props. It was inline in the body-variable
   * map until the header and the buttons needed exactly the same three fields.
   */
  const bindingCard = ({
    key,
    title,
    binding,
    update,
  }: {
    key: string;
    title: string;
    binding: Binding | undefined;
    update: (patch: Partial<Binding>) => void;
  }) => {
    const row = binding ?? { kind: 'field' as const, path: '', value: '', fallback: '' };

    return (
      <Card key={key} title={title}>
        <Field label={t('campaign.source')}>
          <select
            value={row.kind}
            onChange={(event) => update({ kind: event.target.value as 'field' | 'static' })}
            style={input}
          >
            <option value="field">{t('campaign.bindingField')}</option>
            <option value="static">{t('campaign.bindingStatic')}</option>
          </select>
        </Field>

        {row.kind === 'field' ? (
          <Field label={t('campaign.field')}>
            <select
              value={row.path}
              onChange={(event) => update({ path: event.target.value })}
              style={input}
            >
              {paths.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label={t('campaign.text')}>
            <input
              type="text"
              value={row.value}
              onChange={(event) => update({ value: event.target.value })}
              style={input}
            />
          </Field>
        )}

        <Field label={t('campaign.fallback')} hint={t('campaign.fallbackHint')}>
          <input
            type="text"
            value={row.fallback}
            onChange={(event) => update({ fallback: event.target.value })}
            style={input}
          />
        </Field>
      </Card>
    );
  };

  const warnings = accountWarnings(account);
  const missingRows = (sample ?? []).filter((row) => !row.ok);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        /**
         * A form does not get better by being wider. Past roughly this the
         * label/control pairs drift apart until a select on the right belongs
         * to a label the eye has already left; the review measured full-width
         * fields on a 1400px screen.
         */
        maxWidth: '760px',
      }}
    >
      {/*
        The stepper at reading size: a numbered disc per step, filled for the
        current one, checked for the ones already persisted. Hierarchy comes
        from weight and fill, not from making the words smaller.
      */}
      <div
        style={{
          display: 'flex',
          gap: theme.spacing[3],
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        {STEPS.map((key, index) => (
          <span
            key={key}
            aria-current={index === step ? 'step' : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: theme.spacing[1],
              fontSize: theme.font.size.md,
              color: index === step ? theme.font.color.primary : theme.font.color.secondary,
              fontWeight: index === step ? theme.font.weight.semiBold : theme.font.weight.regular,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '20px',
                height: '20px',
                borderRadius: theme.border.radius.rounded,
                fontSize: theme.font.size.sm,
                background: index === step ? theme.color.blue : theme.background.transparent.light,
                color: index === step ? theme.font.color.inverted : theme.font.color.secondary,
              }}
            >
              {index < step ? <Glyph name="completed" /> : index + 1}
            </span>
            {t(key)}
          </span>
        ))}
      </div>

      {error === null ? null : <Banner tone="danger">{error}</Banner>}
      {optionsError ? (
        <Banner tone="danger">
          {t('campaign.optionsFailed')}
          <ActionButton label={t('common.retry')} icon="retry" onClick={() => setOptionsAttempt((attempt) => attempt + 1)} />
        </Banner>
      ) : null}

      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Card title={t(STEPS[step])}>
        {step === 0 ? (
          <>
            <Field label={t('campaign.name')}>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                style={input}
              />
            </Field>
            <Field label={t('campaign.account')}>
              <select
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                style={input}
              >
                {accounts.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} · {candidate.displayPhoneNumber ?? ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('campaign.schedule')} hint={t('campaign.scheduleHint')} error={scheduleValid ? undefined : t('campaign.scheduleInvalid')}>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
                onInput={(event) => setScheduledAt(event.currentTarget.value)}
                style={input}
              />
            </Field>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <Field label={t('campaign.step.template')} hint={t('campaign.templateHint')}>
              <select
                value={templateId}
                onChange={(event) => {
                  setTemplateId(event.target.value);
                  setHeaderFile(null);
                  setHeaderFileUrl('');
                }}
                style={input}
              >
                <option value="">—</option>
                {usable.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} ({candidate.language}) · {candidate.category}
                  </option>
                ))}
              </select>
            </Field>

            {localPreview === null ? null : (
              <Preview rendered={localPreview} note={t('campaign.previewPlaceholders')} t={t} />
            )}
          </>
        ) : null}

        {step === 2 ? (
          <>
            <Field label={t('campaign.source')}>
              <select
                value={audienceKind}
                onChange={(event) => setAudienceKind(event.target.value as AudienceKind)}
                style={input}
              >
                <option value="view">{t('campaign.sourceView')}</option>
                <option value="manual">{t('campaign.sourceManual')}</option>
              </select>
            </Field>

            {audienceKind === 'view' ? (
              <Field label={t('campaign.view')}>
                <select
                  value={viewId}
                  onChange={(event) => setViewId(event.target.value)}
                  style={input}
                >
                  <option value="">—</option>
                  {views.map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <>
                {/*
                  A contact picker, not a UUID box (UX review, highest
                  priority). The results render inline under the search field —
                  portals render nothing here, so there is no dropdown to
                  anchor — and every row carries the phone, because two "Maria
                  Silva"s with only names would put this campaign in the wrong
                  chat.
                */}
                <Field label={t('campaign.personSearch')} hint={t('campaign.personSearchHint')}>
                  <input
                    type="search"
                    value={personQuery}
                    placeholder={t('campaign.personSearchPlaceholder')}
                    onChange={(event) => setPersonQuery(event.target.value)}
                    style={input}
                  />
                </Field>

                {personSearchError ? (
                  <Banner tone="danger">
                    {t('campaign.searchFailed')}
                    <ActionButton label={t('common.retry')} icon="retry" onClick={() => setSearchAttempt((attempt) => attempt + 1)} />
                  </Banner>
                ) : personSearching ? (
                  <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}>
                    {t('common.loading')}
                  </span>
                ) : personQuery.trim().length >= 2 && personResults.length === 0 ? (
                  <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}>
                    {t('campaign.personNoResults', { query: personQuery.trim() })}
                  </span>
                ) : (
                  personResults.map((person) => {
                    const already = selectedPeople.some((row) => row.id === person.id);

                    return (
                      <button
                        key={person.id}
                        type="button"
                        disabled={already}
                        onClick={() =>
                          setSelectedPeople((current) =>
                            current.some((row) => row.id === person.id)
                              ? current
                              : [...current, person],
                          )
                        }
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: theme.spacing[1],
                          minHeight: '32px',
                          border: 'none',
                          borderRadius: theme.border.radius.sm,
                          background: 'transparent',
                          color: already ? theme.font.color.secondary : theme.font.color.secondary,
                          cursor: already ? 'default' : 'pointer',
                          fontFamily: theme.font.family,
                          fontSize: theme.font.size.sm,
                          padding: `0 ${theme.spacing[1]}`,
                          textAlign: 'left',
                        }}
                      >
                        <Glyph name={already ? 'completed' : 'newCampaign'} />
                        {pickedLabel(person)}
                      </button>
                    );
                  })
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
                  <span
                    style={{
                      fontSize: theme.font.size.sm,
                      fontWeight: theme.font.weight.medium,
                      color: theme.font.color.secondary,
                    }}
                  >
                    {t('campaign.personSelected', { count: selectedPeople.length })}
                  </span>

                  {selectedPeople.map((person) => (
                    <span
                      key={person.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: theme.spacing[1],
                        fontSize: theme.font.size.sm,
                        color: theme.font.color.secondary,
                      }}
                    >
                      <span style={{ flex: '1 1 auto', minWidth: 0 }}>{pickedLabel(person)}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedPeople((current) =>
                            current.filter((row) => row.id !== person.id),
                          )
                        }
                        aria-label={`${t('campaign.personRemove')}: ${pickedLabel(person)}`}
                        title={t('campaign.personRemove')}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          minWidth: '24px',
                          minHeight: '24px',
                          border: 'none',
                          borderRadius: theme.border.radius.sm,
                          background: 'transparent',
                          color: theme.font.color.secondary,
                          cursor: 'pointer',
                        }}
                      >
                        <Glyph name="dismiss" />
                      </button>
                    </span>
                  ))}
                </div>
              </>
            )}
          </>
        ) : null}

        {step === 3 ? (
          <>
            {hasVariables ? null : (
              <span style={{ fontSize: theme.font.size.md, color: theme.font.color.secondary }}>
                {t('campaign.noVariables')}
              </span>
            )}

            {/*
              The header file, when the template has one (D-59).

              One address for the whole campaign: the sender uploads it to Meta
              once and every recipient reuses the id. Before this, a template
              with an image header could be built and launched, and then
              excluded every single recipient for a variable the builder had
              never asked about.
            */}
            {mediaHeader === null ? null : (
              <Card title={t(`chat.templateHeader.${mediaHeader.format}`)}>
                {headerFile === null && headerFileValid ? (
                  <div>
                    <p>{headerFileUrl.split('/').pop()?.split('?')[0]}</p>
                    <ActionButton
                      label={t('upload.remove')}
                      onClick={() => setHeaderFileUrl('')}
                      disabled={busy}
                    />
                  </div>
                ) : null}
                <FileUpload
                  key={templateId}
                  t={t}
                  fieldMetadataId={fieldMetadataId}
                  value={headerFile}
                  requiredKind={mediaKindForHeaderFormat(mediaHeader.format) ?? 'document'}
                  disabled={busy}
                  onChange={(file) => {
                    setHeaderFile(file);
                    setHeaderFileUrl('');
                  }}
                />
              </Card>
            )}

            {headerHints.map((hint, index) =>
              bindingCard({
                key: `header-${index}`,
                title: `${t('chat.templateHeader')} · ${hint.context ?? hint.token}`,
                binding: headerBindings[index],
                update: (patch) =>
                  setHeaderBindings((current) =>
                    current.map((row, position) =>
                      position === index ? { ...row, ...patch } : row,
                    ),
                  ),
              }),
            )}

            {labels.map((label, index) =>
              bindingCard({
                key: label,
                title: label,
                binding: bindings[index],
                update: (patch) =>
                  setBindings((current) =>
                    current.map((row, position) =>
                      position === index ? { ...row, ...patch } : row,
                    ),
                  ),
              }),
            )}

            {buttonHints.map((button) =>
              bindingCard({
                key: `button-${button.index}`,
                title: `${
                  button.subType === 'copy_code'
                    ? t('chat.templateCopyCode')
                    : t('chat.templateButtonUrl')
                } · ${button.label ?? t('chat.templateButton')}`,
                binding: buttonBindings[button.index],
                update: (patch) =>
                  setButtonBindings((current) => ({
                    ...current,
                    [button.index]: {
                      ...(current[button.index] ?? {
                        kind: 'static',
                        path: '',
                        value: '',
                        fallback: '',
                      }),
                      ...patch,
                    },
                  })),
              }),
            )}

            {/*
              Live, and local. Every keystroke re-renders it, which no server
              call could survive — and it is honest about what it is: a static
              binding shows its own text, a field binding shows the field's
              name in guillemets. The real values arrive on the next screen.
            */}
            {localPreview === null ? null : <Preview rendered={localPreview} t={t} />}
          </>
        ) : null}

        {step === REVIEW_STEP ? (
          <>
            <SummaryRow label={t('campaign.name')} value={name} />
            <SummaryRow
              label={t('campaign.account')}
              value={`${account?.name ?? '—'} · ${account?.displayPhoneNumber ?? ''}`}
            />
            <SummaryRow
              label={t('campaign.step.template')}
              value={
                template === undefined
                  ? '—'
                  : `${template.name} (${template.language}) · ${template.category}`
              }
            />
            <SummaryRow
              label={t('campaign.step.audience')}
              value={
                audienceKind === 'view'
                  ? t('campaign.reviewAudienceView', {
                      name: views.find((view) => view.id === viewId)?.name ?? viewId,
                    })
                  : t('campaign.reviewAudienceManual', { count: selectedPeople.length })
              }
            />
            <SummaryRow
              label={t('campaign.schedule')}
              value={
                scheduledAt === ''
                  ? t('campaign.reviewScheduleNow')
                  : new Date(scheduledAt).toLocaleString()
              }
            />

            {warnings.length === 0 ? null : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
                <span
                  style={{
                    fontSize: theme.font.size.sm,
                    fontWeight: theme.font.weight.medium,
                    color: theme.font.color.secondary,
                  }}
                >
                  {t('campaign.reviewWarnings')}
                </span>
                {warnings.map((key) => (
                  <span
                    key={key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: theme.spacing[1],
                      fontSize: theme.font.size.sm,
                      color:
                        key === 'campaign.warnNotConnected'
                          ? theme.font.color.danger
                          : theme.font.color.secondary,
                    }}
                  >
                    <Glyph name="warning" />
                    {t(key)}
                  </span>
                ))}
              </div>
            )}

            {sampleError ? (
              <Banner tone="danger">
                {t('campaign.previewFailed')}
                <ActionButton label={t('common.retry')} icon="retry" onClick={() => {
                  if (campaignId) { setSampleError(false); setSample(null); void loadSample(campaignId); }
                }} />
              </Banner>
            ) : sample === null ? (
              <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}>
                {t('common.loading')}
              </span>
            ) : sample.length === 0 ? (
              <Banner>{t('campaign.previewUnavailable')}</Banner>
            ) : (
              <>
                <Preview
                  rendered={sample[0].rendered}
                  note={t('campaign.previewSample', {
                    /*
                      The name first: "with the values of Maria Silva" is what
                      convinces a reader the bindings are right; a phone or a
                      UUID convinces them of nothing (UX review, Review step).
                    */
                    name:
                      [sample[0].name, displayPhone(sample[0].phone)]
                        .filter(
                          (part): part is string => typeof part === 'string' && part.length > 0,
                        )
                        .join(' · ') ||
                      (sample[0].personId ?? '?'),
                  })}
                  t={t}
                />

                {/*
                  A missing variable is not a formatting problem — the snapshot
                  excludes that contact outright (specs/07). Saying so here,
                  against a real sample, is the difference between finding out
                  now and finding out from the exclusion breakdown after the
                  build.
                */}
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.spacing[1],
                    fontSize: theme.font.size.sm,
                    color:
                      missingRows.length === 0
                        ? theme.font.color.secondary
                        : theme.font.color.danger,
                  }}
                >
                  <Glyph name={missingRows.length === 0 ? 'completed' : 'warning'} />
                  {missingRows.length === 0
                    ? t('campaign.reviewNoMissing')
                    : t('campaign.reviewMissing', {
                        count: missingRows.length,
                        total: sample.length,
                        keys: [...new Set(missingRows.flatMap((row) => row.missing))].join(', '),
                      })}
                </span>
              </>
            )}

            <Banner>{t('campaign.reviewCountUnknown')}</Banner>
          </>
        ) : null}
      </Card>
      </fieldset>

      {/*
        Sticky, because the Variables step is as long as the template has
        placeholders and the Review step is longer still — the controls that
        end the flow were at the bottom of a scroll on every step that needed
        them most.
      */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[2],
          flexWrap: 'wrap',
          position: 'sticky',
          bottom: 0,
          background: theme.background.primary,
          borderTop: `1px solid ${theme.border.color.light}`,
          padding: `${theme.spacing[2]} 0`,
        }}
      >
        {step > 0 ? (
          <ActionButton
            label={t('common.back')}
            icon="back"
            disabled={busy}
            onClick={() => { sampleRequest.current += 1; setError(null); setStep((current) => current - 1); }}
          />
        ) : null}
        <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
          {t('campaign.stepOf', { step: step + 1, total: STEPS.length })}
        </span>
        <span style={{ flex: '1 1 auto' }} />
        <ActionButton label={t('common.cancel')} disabled={busy} onClick={onCancel} />
        {name.trim() && accountId && templateId ? (
          <ActionButton label={t('campaign.saveDraft')} busy={busy} onClick={() => void saveDraft()} />
        ) : null}
        {step < REVIEW_STEP ? (
          <ActionButton
            label={t('common.continue')}
            tone="primary"
            busy={busy}
            disabled={!canAdvance}
            onClick={() => void next()}
          />
        ) : (
          <ActionButton
            label={t('campaign.build')}
            tone="primary"
            icon="audience"
            busy={busy}
            onClick={() => void build()}
          />
        )}
      </div>
    </div>
  );
};
