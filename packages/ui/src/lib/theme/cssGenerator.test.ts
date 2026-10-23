import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { withOpacity } from './color';
import { CSSVariableGenerator } from './cssGenerator';
import { themes } from './themes';

const originals = new Map<string, PropertyDescriptor | undefined>();
const theme = themes.find((candidate) => candidate.metadata.id === 'catppuccin-dark') ?? themes[0];

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  for (const [name, value] of Object.entries({ window: dom, document: dom.document })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

const applied = (backgroundOpacity?: number): string => {
  new CSSVariableGenerator().apply(theme, backgroundOpacity);
  return document.getElementById('opencode-theme-variables')?.textContent ?? '';
};

test('a theme without a background opacity emits no translucent window block', () => {
  expect(applied()).not.toContain('--oc-text-backdrop');
});

test('a background opacity lowers only the background tokens and keeps text opaque', () => {
  const css = applied(0.5);
  const block = css.slice(css.indexOf('@layer base'));

  expect(block).toContain(`--oc-text-backdrop: ${theme.colors.surface.background};`);
  expect(block).toContain(`--background: ${withOpacity(theme.colors.surface.background, 0.5)};`);
  expect(block).not.toContain('foreground');
});

test('applying the theme again replaces the block instead of stacking it', () => {
  applied(0.5);
  expect(applied(0.8).match(/--oc-text-backdrop/g)).toHaveLength(1);
  expect(applied()).not.toContain('--oc-text-backdrop');
  expect(document.querySelectorAll('#opencode-theme-variables')).toHaveLength(1);
});
