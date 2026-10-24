import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import express from 'express';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { createNotificationEmitterRuntime } from '../notifications/emitter-runtime.js';
import { createOpenChamberControlService } from './service.js';
import { registerOpenChamberControlRoutes } from './routes.js';
import { createThemeControl } from './theme-control.js';

describe('authenticated theme control', () => {
  it('probes a real SSE connection and waits for its authenticated application result', async () => {
    const auth = createUiAuth({
      requireClientAuth: true,
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'theme-fixture' ? { ok: true, clientId: 'fixture' } : null,
      },
    });
    const clients = new Set();
    const emitter = createNotificationEmitterRuntime({
      process, getDesktopNotifyEnabled: () => false, desktopNotifyPrefix: '',
      getUiNotificationClients: () => new Set(), getOpenChamberEventClients: () => clients,
    });
    const themeControl = createThemeControl({ getClients: () => clients, writeEvent: emitter.writeSseEvent });
    const app = express();
    app.post('/auth/url-token', auth.handleUrlAuthToken);
    app.use('/api', auth.requireAuth);
    registerScheduledTaskRoutes(app, { getOpenChamberEventClients: () => clients, writeSseEvent: emitter.writeSseEvent });
    registerOpenChamberControlRoutes(app, { controlService: createOpenChamberControlService({ themeControl }) });
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: 'Bearer theme-fixture', 'Content-Type': 'application/json' };
    const abort = new AbortController();
    const post = (route, body, authenticated = true) => fetch(`${base}${route}`, {
      method: 'POST', headers: authenticated ? headers : { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    try {
      expect((await post('/api/openchamber/control', { action: 'theme.capabilities' }, false)).status).toBe(401);
      expect((await post('/api/openchamber/theme/result', {}, false)).status).toBe(401);
      expect((await post('/api/openchamber/control', { action: 'theme.capabilities' })).status).toBe(503);
      const tokenResponse = await post('/auth/url-token', {});
      const { token } = await tokenResponse.json();
      const stream = await fetch(`${base}/api/openchamber/events?theme=1&oc_url_token=${encodeURIComponent(token)}`, { signal: abort.signal });
      expect(stream.status).toBe(200);
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      const nextEvent = async () => {
        while (!buffered.includes('\n\n')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Theme stream ended before the expected event');
          buffered += decoder.decode(chunk.value, { stream: true });
        }
        const end = buffered.indexOf('\n\n');
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        return JSON.parse(frame.split('\n').find((line) => line.startsWith('data: ')).slice(6));
      };
      const ready = await nextEvent();
      const connectionId = ready.properties.connectionId;
      expect(connectionId).toBeTruthy();
      expect([...clients][0].openchamberThemeCapable).toBe(true);
      const probe = post('/api/openchamber/control', { action: 'theme.capabilities' });
      const request = await nextEvent();
      expect(request.properties).toMatchObject({ action: 'capabilities', connectionId });
      expect((await post('/api/openchamber/theme/result', {
        requestId: request.properties.requestId, connectionId,
        result: { kind: 'capabilities', transparentWindow: true },
      })).status).toBe(200);
      expect(await (await probe).json()).toMatchObject({
        protocolVersion: 1, ackTimeoutMs: 10000, windows: [{ connectionId, transparentWindow: true }],
      });
      const application = post('/api/openchamber/control', { action: 'theme.set', input: { id: 'fixture' } });
      const setting = await nextEvent();
      expect(setting.properties).toMatchObject({ action: 'set', id: 'fixture', connectionId });
      const body = {
        requestId: setting.properties.requestId, connectionId,
        result: { kind: 'applied', themeId: 'fixture', backgroundOpacity: 0.5, transparentWindow: true },
      };
      const denied = await post('/api/openchamber/theme/result', body, false);
      expect(denied.status).toBe(401);
      const acknowledgment = await post('/api/openchamber/theme/result', body);
      expect(await acknowledgment.json()).toEqual({ matched: true });
      expect(await (await application).json()).toEqual({
        id: 'fixture', delivered: 1,
        applied: [{ connectionId, themeId: 'fixture', backgroundOpacity: 0.5, transparentWindow: true }],
      });
      expect(await (await post('/api/openchamber/theme/result', body)).json()).toEqual({ matched: false });
      expect((await post('/api/openchamber/theme/result', { oversized: 'x'.repeat(5000) })).status).toBe(413);
      await reader.cancel();
    } finally {
      abort.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      auth.dispose();
    }
  });
});
