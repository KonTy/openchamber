import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { z } from 'zod';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { compactTheme } from '@/lib/theme/definition';
import { getDefaultTheme } from '@/lib/theme/themes';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getThemePreferencesStorageKey, writeThemePreferencesForRuntime } from '@/contexts/theme-storage';
import { useExternalThemeSwitch } from './useExternalThemeSwitch';

class ThemeEventSource {
  static CLOSED = 2;
  static instances: ThemeEventSource[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) { ThemeEventSource.instances.push(this); }
  close() { this.readyState = ThemeEventSource.CLOSED; }
  send(requestId: string, action: 'capabilities' | 'set', id?: string) {
    this.onmessage?.({ data: JSON.stringify({
      type: 'openchamber:theme-control-request',
      properties: { requestId, connectionId: 'fixture-window', action, id },
    }) });
  }
}

const resultSchema = z.object({
  requestId: z.string(),
  result: z.object({
    kind: z.string(),
    message: z.string().optional(),
    themeId: z.string().optional(),
    backgroundOpacity: z.number().optional(),
    transparentWindow: z.boolean().optional(),
  }),
});

test('external themes acknowledge rendering and persistence, with explicit failures and no-op retries', async () => {
  const dom = new Window({ url: 'http://theme-control.test' });
  const storageWrites = spyOn(dom.Storage.prototype, 'setItem');
  Object.assign(dom, {
    __OPENCHAMBER_API_BASE_URL__: 'http://theme-control.test',
    __OPENCHAMBER_LOCAL_ORIGIN__: 'http://theme-control.test',
    __OPENCHAMBER_ELECTRON__: { runtime: 'electron', transparentWindow: true },
    __OPENCHAMBER_DESKTOP__: { invoke: async () => null },
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const results: z.infer<typeof resultSchema>[] = [];
  const writes: Array<{ body: string; resolve: (response: Response) => void }> = [];
  let notifyWrite = () => {};
  let readFails = false;
  let holdRead = false;
  let finishRead: ((response: Response) => void) | undefined;
  const fixture = {
    ...getDefaultTheme(true),
    metadata: { ...getDefaultTheme(true).metadata, id: 'fixture-external' },
    config: { backgroundOpacity: 0.5 },
  };
  const alternate = { ...fixture, metadata: { ...fixture.metadata, id: 'fixture-alternate' } };
  const fetchResponse = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/api/config/themes')) {
      if (holdRead) return new Promise((resolve) => { finishRead = resolve; });
      return Promise.resolve(readFails ? new Response(null, { status: 503 }) : Response.json({
        themes: [compactTheme(fixture), compactTheme(alternate)],
      }));
    }
    if (url.includes('/api/config/settings') && init?.method === 'PUT') {
      const body = String(init.body);
      return new Promise((resolve) => { writes.push({ body, resolve }); notifyWrite(); });
    }
    if (url.includes('/api/openchamber/theme/result')) {
      results.push(resultSchema.parse(JSON.parse(String(init?.body))));
      return Promise.resolve(Response.json({ matched: true }));
    }
    return Promise.resolve(new Response(null, { status: 501 }));
  };
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, Element: dom.Element, HTMLElement: dom.HTMLElement,
    Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent, StorageEvent: dom.StorageEvent,
    EventSource: ThemeEventSource, fetch: fetchResponse, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  const root = createRoot(container);
  let chooseTheme: (id: string) => void = () => { throw new Error('Expected a mounted theme provider'); };
  function Handler() {
    const theme = useThemeSystem();
    chooseTheme = theme.setTheme;
    useExternalThemeSwitch();
    return <output data-theme={theme.currentTheme.metadata.id} />;
  }
  const stream = () => {
    const source = ThemeEventSource.instances.at(-1);
    if (!source) throw new Error('Expected the native control stream');
    return source;
  };
  const answerWrite = async (ok: boolean) => {
    const write = writes.shift();
    if (!write) throw new Error('Expected a settings write');
    await act(async () => write.resolve(ok
      ? Response.json(JSON.parse(write.body))
      : new Response(null, { status: 503 })));
  };
  try {
    await act(async () => root.render(<ThemeSystemProvider><Handler /></ThemeSystemProvider>));
    expect(new URL(stream().url, 'http://theme-control.test').searchParams.get('theme')).toBe('1');
    await act(async () => stream().send('probe', 'capabilities'));
    expect(results.at(-1)).toEqual({ requestId: 'probe', result: { kind: 'capabilities', transparentWindow: true } });

    const posted = new Promise<void>((resolve) => { notifyWrite = resolve; });
    await act(async () => stream().send('first', 'set', fixture.metadata.id));
    await act(async () => { await posted; });
    expect(localStorage.getItem('selectedThemeId')).toBe(fixture.metadata.id);
    expect(container.querySelector('output')?.dataset.theme).toBe(fixture.metadata.id);
    expect(results.some((entry) => entry.requestId === 'first')).toBe(false);
    await answerWrite(false);
    expect(results.at(-1)?.result.kind).toBe('error');
    expect(results.at(-1)?.result.message).toContain('could not be saved');

    const retried = new Promise<void>((resolve) => { notifyWrite = resolve; });
    await act(async () => stream().send('retry', 'set', fixture.metadata.id));
    await act(async () => { await retried; });
    await answerWrite(true);
    expect(results.at(-1)).toEqual({
      requestId: 'retry',
      result: { kind: 'applied', themeId: fixture.metadata.id, backgroundOpacity: 0.5, transparentWindow: true },
    });

    fixture.config.backgroundOpacity = 0.75;
    const preferenceKey = getThemePreferencesStorageKey(getRuntimeKey());
    expect(getRuntimeKey()).toBe('local');
    const publishedBeforeReload = storageWrites.mock.calls.filter(([key]) => key === preferenceKey).length;
    expect(publishedBeforeReload).toBeGreaterThan(0);
    await act(async () => stream().send('noop', 'set', fixture.metadata.id));
    expect(results.at(-1)?.requestId).toBe('noop');
    expect(results.at(-1)?.result).toMatchObject({ kind: 'applied', backgroundOpacity: 0.75 });
    expect(writes).toHaveLength(0);
    expect(storageWrites.mock.calls.filter(([key]) => key === preferenceKey)).toHaveLength(publishedBeforeReload);

    Object.assign(dom, { __OPENCHAMBER_ELECTRON__: { runtime: 'electron', transparentWindow: false } });
    await act(async () => stream().send('opaque', 'set', fixture.metadata.id));
    expect(results.at(-1)?.result).toMatchObject({ kind: 'applied', backgroundOpacity: 1, transparentWindow: false });

    const superseded = new Promise<void>((resolve) => { notifyWrite = resolve; });
    await act(async () => stream().send('superseded', 'set', alternate.metadata.id));
    await act(async () => { await superseded; });
    const latestSaved = new Promise<void>((resolve) => { notifyWrite = resolve; });
    await act(async () => chooseTheme(fixture.metadata.id));
    await answerWrite(true);
    await act(async () => { await latestSaved; });
    await answerWrite(true);
    expect(results.find((entry) => entry.requestId === 'superseded')?.result.kind).toBe('error');
    expect(results.find((entry) => entry.requestId === 'superseded')?.result.message).toContain('selection changed');
    expect(container.querySelector('output')?.dataset.theme).toBe(fixture.metadata.id);

    holdRead = true;
    const fromAnotherWindow = new Promise<void>((resolve) => { notifyWrite = resolve; });
    await act(async () => stream().send('same-target-window', 'set', alternate.metadata.id));
    await act(async () => {
      writeThemePreferencesForRuntime(getRuntimeKey(), {
        themeMode: 'dark',
        lightThemeId: getDefaultTheme(false).metadata.id,
        darkThemeId: alternate.metadata.id,
      });
      window.dispatchEvent(new StorageEvent('storage', {
        key: getThemePreferencesStorageKey(getRuntimeKey()), storageArea: dom.localStorage,
      }));
    });
    holdRead = false;
    await act(async () => finishRead?.(Response.json({ themes: [compactTheme(fixture), compactTheme(alternate)] })));
    await act(async () => { await fromAnotherWindow; });
    await answerWrite(true);
    expect(results.find((entry) => entry.requestId === 'same-target-window')?.result).toMatchObject({
      kind: 'applied', themeId: alternate.metadata.id,
    });

    holdRead = true;
    await act(async () => stream().send('changed-during-read', 'set', fixture.metadata.id));
    const manuallyChanged = new Promise<void>((resolve) => { notifyWrite = resolve; });
    await act(async () => chooseTheme(getDefaultTheme(true).metadata.id));
    await act(async () => { await manuallyChanged; });
    holdRead = false;
    await act(async () => finishRead?.(Response.json({ themes: [compactTheme(fixture), compactTheme(alternate)] })));
    await answerWrite(true);
    expect(results.find((entry) => entry.requestId === 'changed-during-read')?.result.kind).toBe('error');
    expect(results.find((entry) => entry.requestId === 'changed-during-read')?.result.message).toContain('selection changed');
    expect(container.querySelector('output')?.dataset.theme).toBe(getDefaultTheme(true).metadata.id);

    await act(async () => stream().send('missing', 'set', 'absent-theme'));
    expect(results.at(-1)?.result.kind).toBe('error');
    expect(results.at(-1)?.result.message).toContain('missing or invalid');
    readFails = true;
    await act(async () => stream().send('failed-read', 'set', fixture.metadata.id));
    expect(results.at(-1)?.result).toEqual({ kind: 'error', message: 'Could not reload custom themes' });
    expect(writes).toHaveLength(0);
    holdRead = true;
    await act(async () => stream().send('unmounted', 'set', fixture.metadata.id));
    await act(async () => root.render(<ThemeSystemProvider>{null}</ThemeSystemProvider>));
    await act(async () => finishRead?.(Response.json({ themes: [compactTheme(fixture)] })));
    expect(results.some((entry) => entry.requestId === 'unmounted')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    storageWrites.mockRestore();
    dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
