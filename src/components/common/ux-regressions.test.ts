// @vitest-environment jsdom
import { createElement as h } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Composer, type ComposerProps } from '../chat/Composer';
import { Field, Banner } from './ui';
import { translateWith } from './copy';
import { deriveVariableSpec } from '../../domain/template-spec';
import { useFeed, type FeedEnvelope } from './use-feed';
import { CampaignBuilder } from '../campaigns/CampaignBuilder';
import { InboxView } from '../inbox/InboxView';
import { ThreadView } from '../chat/ThreadView';
import { SettingsView } from '../settings/SettingsView';
import { CampaignDetail } from '../campaigns/CampaignDetail';
import { CampaignsView } from '../campaigns/CampaignsView';
import { projectThread, projectAccount } from '../../domain/feed/projection';
import { browserDateTime } from './format';
import { FileUpload } from '../chat/builders/FileUpload';
import type { FeedTemplate } from './use-feed';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), uploadFile: vi.fn(), confirm: vi.fn() }));
vi.mock('twenty-client-sdk/rest', () => ({ RestApiClient: class { get = mocks.get; post = mocks.post; } }));
vi.mock('twenty-sdk/front-component', () => ({
  useLocale: () => 'en', getApplicationVariable: () => undefined,
  uploadFile: mocks.uploadFile, openCommandConfirmationModal: mocks.confirm,
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../inbox/InboundToaster', () => ({ InboundToaster: () => null }));
vi.mock('twenty-ui/input', () => ({ Button: ({ title, onClick, disabled }: { title: string; onClick: () => void; disabled: boolean }) => h('button', { onClick, disabled }, title) }));
vi.mock('twenty-ui/data-display', () => ({ Tag: ({ text }: { text: string }) => h('span', null, text) }));

const t = translateWith('en');
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const template: FeedTemplate = {
  id: 'template', name: 'Greeting', language: 'en', category: 'UTILITY', qualityScore: null,
  variableSpec: deriveVariableSpec([{ type: 'BODY', text: 'Hello {{1}}' }]) as unknown as Record<string, unknown>,
  components: null,
};
const composerProps = (patch: Partial<ComposerProps> = {}): ComposerProps => ({
  policy: { allowed: true, reason: null, warnings: [] }, capabilities: undefined,
  canSend: true, t, templates: [template], isSending: false, refusal: null,
  fieldErrors: [], replyTarget: null, person: null,
  onSendText: vi.fn().mockResolvedValue(true), onSendTemplate: vi.fn().mockResolvedValue(true),
  onSendMedia: vi.fn().mockResolvedValue(true), onSendLocation: vi.fn().mockResolvedValue(true),
  onSendContact: vi.fn().mockResolvedValue(true), onSendInteractive: vi.fn().mockResolvedValue(true),
  onCancelReply: vi.fn(), onDismissRefusal: vi.fn(), ...patch,
});
const envelope = (scope = 'inbox'): FeedEnvelope => ({
  scope, nextSince: '2026-11-03T00:00:00Z', serverTime: '2026-11-03T00:00:00Z',
  permissions: { canSend: true, canManageCampaigns: true, canManageTemplates: true, workspaceMemberId: 'me' },
  threads: [], messages: [],
});

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('recoverable composer submissions', () => {
  it('preserves a refused text draft and sends it again deliberately', async () => {
    const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(h(Composer, composerProps({ onSendText: send })));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((input as HTMLTextAreaElement).value).toBe('Keep this draft');
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
  });

  it('ignores duplicate clicks and keeps the next draft typed during a request', async () => {
    const request = deferred<boolean>();
    const send = vi.fn(() => request.promise);
    render(h(Composer, composerProps({ onSendText: send })));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'First' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
    fireEvent.change(input, { target: { value: 'Next message' } });
    await act(async () => request.resolve(true));
    expect(send).toHaveBeenCalledTimes(1);
    expect((input as HTMLTextAreaElement).value).toBe('Next message');
  });

  it('does not send Enter used to commit an IME composition', () => {
    const send = vi.fn().mockResolvedValue(true);
    render(h(Composer, composerProps({ onSendText: send })));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'こんにちは' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps template parameters after refusal and releases the submit guard', async () => {
    const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(h(Composer, composerProps({ onSendTemplate: send })));
    fireEvent.click(screen.getByRole('button', { name: 'Choose a template' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Maria' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((input as HTMLInputElement).value).toBe('Maria');
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('uses an ordinary disclosure and closes it with Escape', () => {
    render(h(Composer, composerProps()));
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    expect(screen.getByRole('group')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' });
    expect(screen.queryByRole('group')).toBeNull();
  });
});

describe('feed request races', () => {
  it('starts a new filter immediately and ignores the old response and cleanup', async () => {
    const old = deferred<FeedEnvelope>();
    const next = deferred<FeedEnvelope>();
    mocks.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderHook(({ filter }) => useFeed({ scope: 'inbox', filter }), { initialProps: { filter: 'mine' } });
    rerender({ filter: 'all' });
    expect(mocks.get).toHaveBeenCalledTimes(2);
    await act(async () => old.reject(new Error('Old filter failed')));
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(true);
    await act(async () => next.resolve(envelope()));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeTruthy();
  });

  it('queues a requested refresh instead of losing it behind an in-flight poll', async () => {
    const first = deferred<FeedEnvelope>();
    mocks.get.mockReturnValueOnce(first.promise).mockResolvedValue(envelope());
    const { result } = renderHook(() => useFeed({ scope: 'inbox' }));
    act(() => result.current.refresh());
    await act(async () => first.resolve(envelope()));
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.get.mock.calls[1][1].query.since).toBe(envelope().nextSince);
  });

  it('clears a previous subject error while the next subject loads', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Denied')).mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHook(({ id }) => useFeed({ scope: 'thread', id }), { initialProps: { id: 'one' } });
    await waitFor(() => expect(result.current.isUnavailable).toBe(true));
    rerender({ id: 'two' });
    expect(result.current.error).toBeNull();
    expect(result.current.isUnavailable).toBe(false);
    expect(result.current.isLoading).toBe(true);
  });
});

describe('form accessibility', () => {
  it('associates field labels, guidance and errors with the actual input', () => {
    const { rerender } = render(h(Field, { label: 'Schedule', hint: 'Your local time', children: h('input') }));
    const input = screen.getByLabelText('Schedule');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('Your local time');
    rerender(h(Field, { label: 'Schedule', error: 'Choose a future date', children: h('input') }));
    expect(screen.getByLabelText('Schedule').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('Choose a future date');
  });
  it('announces failures as alerts and ordinary progress as status', () => {
    const { rerender } = render(h(Banner, { tone: 'danger', children: 'Failed' }));
    expect(screen.getByRole('alert').textContent).toBe('Failed');
    rerender(h(Banner, { children: 'Saved' }));
    expect(screen.getByRole('status').textContent).toBe('Saved');
  });
});

describe('upload review', () => {
  it('shows a failed selection filename and retries the same file', async () => {
    const changed = vi.fn();
    mocks.uploadFile.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ status: 'uploaded', file: { fileId: 'file', path: 'files/file.pdf', url: '/file.pdf', size: 4, mimeType: 'application/pdf' } });
    render(h(FileUpload, { fieldMetadataId: 'field', value: null, onChange: changed, t }));
    const file = new File(['data'], 'proposal.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Choose file'), { target: { files: [file] } });
    await screen.findByRole('alert');
    expect(screen.getByText(/proposal.pdf/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'file', filename: 'proposal.pdf' })));
  });
});

describe('campaign editing', () => {
  const accounts = [projectAccount({ id: 'account', name: 'Demo', status: 'CONNECTED' })!];
  const builder = (resume: Record<string, unknown> | null = null) => h(CampaignBuilder, {
    accounts, templates: [template], resume, onDone: vi.fn(), onCancel: vi.fn(),
  });
  beforeEach(() => {
    mocks.post.mockImplementation((_path, body) => {
      if (body.action === 'audienceOptions') return Promise.resolve({ views: [], bindingPaths: ['person.firstName'] });
      if (body.action === 'personSearch') return Promise.resolve({ people: [] });
      return Promise.resolve({ campaign: { id: 'campaign' } });
    });
  });

  it('round trips stored instants through the browser datetime-local field', () => {
    const instant = '2027-03-20T12:30:00Z';
    expect(new Date(browserDateTime(instant)).toISOString()).toBe(instant.replace('00Z', '00.000Z'));
    expect(browserDateTime('not a date')).toBe('');
  });

  it('rejects past schedules with a field-associated error', async () => {
    render(builder());
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Campaign' } });
    fireEvent.input(screen.getByLabelText('Schedule'), { target: { value: '2020-01-01T12:00' } });
    expect(screen.getByLabelText('Schedule').getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears an existing schedule and sends null while saving once on repeated clicks', async () => {
    const saved = deferred<unknown>();
    mocks.post.mockImplementation((_path, body) => body.action === 'update' ? saved.promise : Promise.resolve({ views: [], bindingPaths: [] }));
    render(builder({ id: 'campaign', name: 'Campaign', accountId: 'account', scheduledAt: '2027-01-01T12:00:00Z' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'template' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const writes = mocks.post.mock.calls.filter(([, body]) => body.action === 'update');
    expect(writes).toHaveLength(1);
    expect(writes[0][1].scheduledAt).toBeNull();
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => saved.resolve({}));
  });

  it('ignores an earlier audience search that arrives after the current search', async () => {
    const old = deferred<unknown>();
    const next = deferred<unknown>();
    mocks.post.mockImplementation((_path, body) => {
      if (body.action === 'audienceOptions') return Promise.resolve({ views: [], bindingPaths: [] });
      if (body.action === 'personSearch') return body.query === 'Ma' ? old.promise : next.promise;
      return Promise.resolve({});
    });
    render(builder({ id: 'campaign', name: 'Campaign', accountId: 'account', templateId: 'template' }));
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'manual' } });
    fireEvent.change(screen.getByLabelText('Search contacts'), { target: { value: 'Ma' } });
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/s/whatsapp/campaign', expect.objectContaining({ query: 'Ma' })));
    fireEvent.change(screen.getByLabelText('Search contacts'), { target: { value: 'Jo' } });
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/s/whatsapp/campaign', expect.objectContaining({ query: 'Jo' })));
    await act(async () => next.resolve({ people: [{ id: 'jo', name: 'Joana', phone: null }] }));
    expect(screen.getByRole('button', { name: /Joana/ })).toBeTruthy();
    await act(async () => old.resolve({ people: [{ id: 'ma', name: 'Maria', phone: null }] }));
    expect(screen.queryByRole('button', { name: /Maria/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Joana/ })).toBeTruthy();
  });
});


describe('navigation and action recovery', () => {
  const threads = [projectThread({ id: 'one', profileName: 'Conversation One', status: 'OPEN' }), projectThread({ id: 'two', profileName: 'Conversation Two', status: 'OPEN' })];
  beforeEach(() => {
    mocks.post.mockResolvedValue({});
    mocks.get.mockImplementation((_url, { query }) => Promise.resolve({
      ...envelope(query.scope), threads, thread: threads.find((row) => row.id === query.id),
      policy: { allowed: true, reason: null, warnings: [] }, templates: [template],
    }));
  });

  it('does not run inbox shortcuts inside conversation controls', async () => {
    render(h(InboxView));
    fireEvent.click(await screen.findByRole('button', { name: 'Conversation One' }));
    const attach = await screen.findByRole('button', { name: 'Attach' });
    await waitFor(() => expect((attach as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(attach, { key: 'ArrowDown' });
    fireEvent.keyDown(attach, { key: 'a' });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.get.mock.calls.some(([, { query }]) => query.id === 'two')).toBe(false);
  });

  it('keeps the selected secondary filter visible when More filters is collapsed', async () => {
    render(h(InboxView));
    fireEvent.click(await screen.findByRole('button', { name: 'More filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Closed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fewer filters' }));
    expect(screen.getByRole('button', { name: 'Closed' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows server refusals for Close and Block and allows a deliberate retry', async () => {
    mocks.confirm.mockResolvedValue('confirm');
    mocks.post.mockRejectedValue({ status: 403, body: { error: 'Permission changed' } });
    render(h(ThreadView, { threadId: 'one', variant: 'inbox' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Permission changed');
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('alert').textContent).toBe('Permission changed');
  });

  it('offers Back and Retry after a campaign detail read fails', async () => {
    mocks.get.mockImplementation((_url, { query }) => {
      if (query.scope === 'campaign' && query.id) return Promise.reject(new Error('Campaign unavailable'));
      return Promise.resolve({ ...envelope(query.scope), campaigns: [{ id: 'c', name: 'Campaign QA', status: 'DRAFT' }] });
    });
    render(h(CampaignsView));
    fireEvent.click(await screen.findByRole('button', { name: /Open campaign: Campaign QA/ }));
    expect(await screen.findByRole('button', { name: 'Back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});


describe('saving and retrying administration flows', () => {
  it('saves the current campaign draft without requiring another wizard step', async () => {
    const done = vi.fn();
    mocks.post.mockImplementation((_url, body) => Promise.resolve(body.action === 'audienceOptions'
      ? { views: [], bindingPaths: [] } : { campaign: { id: 'saved-draft' } }));
    render(h(CampaignBuilder, {
      accounts: [projectAccount({ id: 'account', name: 'Demo' })!], templates: [template],
      onDone: done, onCancel: vi.fn(),
    }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'template' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(done).toHaveBeenCalledWith('saved-draft'));
    expect(mocks.post).toHaveBeenCalledWith('/s/whatsapp/campaign', expect.objectContaining({
      action: 'create', name: 'My draft', templateId: 'template', scheduledAt: null,
      variableMapping: expect.any(Object),
    }));
  });

  it('lets settings retry a failed initial permission check without reloading the host', async () => {
    mocks.post.mockRejectedValueOnce({ status: 403, body: { error: 'Permission check failed' } }).mockResolvedValue({
      accounts: [], rows: [], webhook: { requiredFields: [] }, failedEvents: [], stuckOutbound: [], failedOutbound: [],
    });
    render(h(SettingsView));
    await screen.findByText('Permission check failed');
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByText('Permission check failed')).toBeNull());
  });

  it('does not offer campaign launch until a failed preflight is retried successfully', async () => {
    mocks.post.mockRejectedValueOnce(new Error('Preflight failed')).mockResolvedValue({
      recipients: { total: 3, excluded: 0, breakdown: {}, samples: {} },
      cost: { estimatedUsd: .1, ratePerMessageUsd: .03, note: '' },
      tier: null, quality: { rating: 'GREEN', gate: { allowed: true } }, template: null, preview: [],
    });
    render(h(CampaignDetail, {
      campaign: { id: 'campaign', name: 'Campaign', status: 'READY' }, recipients: [],
      canManage: true, t, lang: 'en', now: new Date(), onBack: vi.fn(), onChanged: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn(),
    }));
    await screen.findByText('Preflight failed');
    expect(screen.queryByRole('button', { name: 'Launch' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Launch' })).toBeTruthy();
  });
});


it('waits for campaign sources before opening a builder with empty initial state', async () => {
  const bootstrap = deferred<FeedEnvelope>();
  mocks.get.mockImplementation((_url, { query }) => query.scope === 'bootstrap'
    ? bootstrap.promise : Promise.resolve({ ...envelope('campaign'), campaigns: [] }));
  render(h(CampaignsView));
  await screen.findAllByRole('button', { name: 'New campaign' });
  expect(screen.getAllByRole('button', { name: 'New campaign' }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  await act(async () => bootstrap.resolve(envelope('bootstrap')));
  expect(screen.getAllByRole('button', { name: 'New campaign' }).every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
});

it('labels controls wrapped by the host renderer as well as intrinsic inputs', () => {
  const HostControl = (props: Record<string, unknown>) => h('input', props);
  render(h(Field, { label: 'Host field', hint: 'Host hint', children: h(HostControl) }));
  const input = screen.getByLabelText('Host field');
  expect(input.getAttribute('aria-describedby')).toBeTruthy();
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('Host hint');
});
