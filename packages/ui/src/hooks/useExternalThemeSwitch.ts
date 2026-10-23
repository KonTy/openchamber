/** Applies a theme switch requested from outside the app. The theme can be a file written just before the request, so the custom themes load again first. */

import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

export const useExternalThemeSwitch = (): void => {
  const { availableThemes, customThemesLoading, reloadCustomThemes, setTheme } = useThemeSystem();
  const [requestedId, setRequestedId] = React.useState<string | null>(null);

  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'theme-set-request') return;
    void reloadCustomThemes();
    setRequestedId(event.id);
  }), [reloadCustomThemes]);

  React.useEffect(() => {
    if (!requestedId || customThemesLoading) return;
    setRequestedId(null);
    if (availableThemes.some((theme) => theme.metadata.id === requestedId)) setTheme(requestedId);
  }, [availableThemes, customThemesLoading, requestedId, setTheme]);
};
