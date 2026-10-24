import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { ThemeSystemProvider } from './ThemeSystemContext';
import { useThemeSystem } from './useThemeSystem';
import type { ThemeContextValue } from './theme-system-context';
import type { ThemeMode } from '@/types/theme';

type Variant = 'light' | 'dark';

async function withProvider(prefersColorScheme: Variant, run: (current: () => ThemeContextValue) => Promise<void>) {
  const dom = new Window({ url: 'http://theme.test', settings: { device: { prefersColorScheme } } });
  Object.assign(dom, {
    __OPENCHAMBER_API_BASE_URL__: 'http://theme.test',
    __OPENCHAMBER_LOCAL_ORIGIN__: 'http://theme.test',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const fetchResponse = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    return Promise.resolve(Response.json(url.endsWith('/api/config/themes')
      ? { themes: [] }
      : init?.method === 'PUT' ? JSON.parse(String(init.body)) : {}));
  };
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, Element: dom.Element, HTMLElement: dom.HTMLElement,
    Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    fetch: fetchResponse, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let context: ThemeContextValue | undefined;
  function Probe() {
    context = useThemeSystem();
    return null;
  }
  const current = () => {
    if (!context) throw new Error('Theme context has not mounted');
    return context;
  };
  try {
    await act(async () => root.render(<ThemeSystemProvider><Probe /></ThemeSystemProvider>));
    await run(current);
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
}

const pickFor = (context: ThemeContextValue, variant: Variant) =>
  variant === 'dark' ? context.setDarkThemePreference : context.setLightThemePreference;

const rows: Array<{ from: ThemeMode; os: Variant; pick: Variant; mode: ThemeMode }> = [
  { from: 'system', os: 'dark', pick: 'dark', mode: 'system' },
  { from: 'system', os: 'light', pick: 'light', mode: 'system' },
  { from: 'system', os: 'dark', pick: 'light', mode: 'light' },
  { from: 'system', os: 'light', pick: 'dark', mode: 'dark' },
  { from: 'light', os: 'dark', pick: 'light', mode: 'light' },
  { from: 'light', os: 'dark', pick: 'dark', mode: 'dark' },
  { from: 'dark', os: 'light', pick: 'dark', mode: 'dark' },
  { from: 'dark', os: 'light', pick: 'light', mode: 'light' },
];

for (const { from, os, pick, mode } of rows) {
  test(`a ${pick} theme pick in ${from} mode on a ${os} OS ends in ${mode} mode showing the pick`, async () => {
    await withProvider(os, async (current) => {
      await act(async () => current().setThemeMode(from));
      const saved = pick === 'dark' ? current().darkThemeId : current().lightThemeId;
      const picked = current().availableThemes.find((theme) => theme.metadata.variant === pick && theme.metadata.id !== saved);
      if (!picked) throw new Error(`No second ${pick} theme`);
      await act(async () => pickFor(current(), pick)(picked.metadata.id));
      expect(current().themeMode).toBe(mode);
      expect(current().currentTheme.metadata.id).toBe(picked.metadata.id);
    });
  });
}

test('picking the theme already saved for the variant that is not on screen shows it', async () => {
  await withProvider('dark', async (current) => {
    await act(async () => current().setDarkThemePreference(current().darkThemeId));
    expect(current().themeMode).toBe('system');
    await act(async () => current().setThemeMode('light'));
    await act(async () => current().setDarkThemePreference(current().darkThemeId));
    expect(current().themeMode).toBe('dark');
    expect(current().currentTheme.metadata.id).toBe(current().darkThemeId);
  });
});
