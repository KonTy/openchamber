import React from 'react';
import { z } from 'zod';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { isDesktopTransparentWindow } from '@/lib/desktop';
import { subscribeOpenchamberEvents, type ThemeControlRequest } from '@/lib/openchamberEvents';
import { updateDesktopSettings } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { Theme, ThemeMode } from '@/types/theme';

type ThemeResult =
  | { kind: 'capabilities'; transparentWindow: boolean }
  | { kind: 'applied'; themeId: string; backgroundOpacity: number; transparentWindow: boolean }
  | { kind: 'error'; message: string };

type SelectionRequest = {
  id: string;
  runtimeKey: string;
  revision: number;
  control: ThemeControlRequest | null;
  initialPreferences: { themeMode: ThemeMode; lightThemeId: string; darkThemeId: string };
};
type PendingSelection = SelectionRequest & (
  | { phase: 'select' }
  | { phase: 'render' | 'persist'; theme: Theme }
);

const postResult = async (request: ThemeControlRequest, result: ThemeResult, runtimeKey: string) => {
  if (runtimeKey !== getRuntimeKey()) {
    console.warn('Theme acknowledgment cancelled after a runtime switch');
    return;
  }
  try {
    const response = await runtimeFetch('/api/openchamber/theme/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: request.requestId, connectionId: request.connectionId, result }),
    });
    if (!response.ok) throw new Error(`Theme acknowledgment returned ${response.status}`);
    const acknowledgment = z.object({ matched: z.boolean() }).parse(await response.json());
    if (!acknowledgment.matched) console.warn('Theme request expired before its acknowledgment');
  } catch (error) {
    console.warn('Could not report the theme request result:', error);
  }
};

export const useExternalThemeSwitch = (): void => {
  const {
    availableThemes, currentTheme, reloadCustomThemes, setTheme,
    themeMode, lightThemeId, darkThemeId,
  } = useThemeSystem();
  const [pending, setPending] = React.useState<PendingSelection | null>(null);
  const revision = React.useRef(0);
  const selection = React.useRef({ currentTheme, themeMode, lightThemeId, darkThemeId });

  React.useEffect(() => {
    selection.current = { currentTheme, themeMode, lightThemeId, darkThemeId };
  }, [currentTheme, themeMode, lightThemeId, darkThemeId]);

  React.useEffect(() => {
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type !== 'theme-set-request' && event.type !== 'theme-control-request') return;
      const runtimeKey = getRuntimeKey();
      if (event.type === 'theme-control-request' && event.action === 'capabilities') {
        void postResult(event, { kind: 'capabilities', transparentWindow: isDesktopTransparentWindow() }, runtimeKey);
        return;
      }
      const request: SelectionRequest = {
        id: event.id,
        control: event.type === 'theme-control-request' ? event : null,
        runtimeKey,
        revision: ++revision.current,
        initialPreferences: {
          themeMode: selection.current.themeMode,
          lightThemeId: selection.current.lightThemeId,
          darkThemeId: selection.current.darkThemeId,
        },
      };
      setPending(null);
      void reloadCustomThemes().then((loaded) => {
        if (request.revision !== revision.current || runtimeKey !== getRuntimeKey()) return;
        if (loaded === null) {
          if (request.control) void postResult(request.control, { kind: 'error', message: 'Could not reload custom themes' }, runtimeKey);
          return;
        }
        setPending({ ...request, phase: 'select' });
      });
    }, { themeControl: true });
    return () => {
      revision.current += 1;
      unsubscribe();
    };
  }, [reloadCustomThemes]);

  React.useEffect(() => {
    if (!pending || pending.runtimeKey !== getRuntimeKey() || pending.revision !== revision.current) return;
    const fail = (message: string) => {
      setPending(null);
      if (pending.control) void postResult(pending.control, { kind: 'error', message }, pending.runtimeKey);
      else console.warn(message);
    };
    if (pending.phase === 'select') {
      const theme = availableThemes.find((candidate) => candidate.metadata.id === pending.id);
      if (!theme) {
        fail('The requested theme is missing or invalid');
        return;
      }
      const initial = pending.initialPreferences;
      const unchanged = themeMode === initial.themeMode
        && lightThemeId === initial.lightThemeId && darkThemeId === initial.darkThemeId;
      // Another targeted window can publish this same selection before our reload finishes.
      const alreadySelected = themeMode === theme.metadata.variant
        && lightThemeId === (theme.metadata.variant === 'light' ? pending.id : initial.lightThemeId)
        && darkThemeId === (theme.metadata.variant === 'dark' ? pending.id : initial.darkThemeId);
      if (!unchanged && !alreadySelected) {
        fail('The theme selection changed while custom themes were loading');
        return;
      }
      setPending({ ...pending, phase: 'render', theme });
      setTheme(pending.id);
      return;
    }
    if (pending.phase !== 'render' || currentTheme !== pending.theme || themeMode !== pending.theme.metadata.variant) return;
    setPending({ ...pending, phase: 'persist' });
    const expected = { currentTheme, themeMode, lightThemeId, darkThemeId };
    void updateDesktopSettings({
      themeId: pending.id,
      themeVariant: currentTheme.metadata.variant,
      useSystemTheme: false,
      lightThemeId,
      darkThemeId,
    }).then((saved) => {
      if (pending.runtimeKey !== getRuntimeKey() || pending.revision !== revision.current) return;
      const actual = selection.current;
      if (!saved.ok) {
        fail('The theme was rendered but its settings could not be saved');
        return;
      }
      if (actual.currentTheme !== expected.currentTheme || actual.themeMode !== expected.themeMode
        || actual.lightThemeId !== expected.lightThemeId || actual.darkThemeId !== expected.darkThemeId) {
        fail('The theme selection changed before persistence was confirmed');
        return;
      }
      setPending(null);
      if (pending.control) {
        const transparentWindow = isDesktopTransparentWindow();
        void postResult(pending.control, {
          kind: 'applied',
          themeId: pending.id,
          backgroundOpacity: transparentWindow ? currentTheme.config?.backgroundOpacity ?? 1 : 1,
          transparentWindow,
        }, pending.runtimeKey);
      }
    }).catch(() => {
      if (pending.runtimeKey !== getRuntimeKey() || pending.revision !== revision.current) return;
      fail('The theme settings write failed');
    });
  }, [availableThemes, currentTheme, darkThemeId, lightThemeId, pending, setTheme, themeMode]);
};
