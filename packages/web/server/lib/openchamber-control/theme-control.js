import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OpenChamberControlError } from './error.js';

const ACK_TIMEOUT_MS = 10_000;
const windowSchema = z.object({ transparentWindow: z.boolean() });
const resultSchema = z.object({
  requestId: z.string().min(1),
  connectionId: z.string().min(1),
  result: z.discriminatedUnion('kind', [
    windowSchema.extend({ kind: z.literal('capabilities') }),
    windowSchema.extend({
      kind: z.literal('applied'),
      themeId: z.string().min(1),
      backgroundOpacity: z.number().gt(0).max(1),
    }),
    z.object({ kind: z.literal('error'), message: z.string().min(1).max(500) }),
  ]),
});

export const createThemeControl = ({ getClients, writeEvent }) => {
  const pending = new Map();

  const request = (action, id, signal) => {
    if (signal?.aborted) return Promise.reject(new OpenChamberControlError('Theme request cancelled', 499));
    if (pending.size >= 8) return Promise.reject(new OpenChamberControlError('Too many pending theme requests', 429));
    if (action === 'set' && [...pending.values()].some((entry) => entry.action === 'set')) {
      return Promise.reject(new OpenChamberControlError('Another theme switch is still pending', 409));
    }
    const clients = [...getClients()].filter((client) => client.openchamberThemeCapable === true && !client.writableEnded);
    if (clients.length === 0) {
      return Promise.reject(new OpenChamberControlError('No theme-capable OpenChamber window is connected', 503));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const responses = new Map();
      const fail = (message, statusCode) => {
        cleanup();
        reject(new OpenChamberControlError(message, statusCode, action === 'set'
          ? { partial: true, partialAction: 'theme.set' }
          : {}));
      };
      const onAbort = () => fail('Theme request cancelled; application may be incomplete', 499);
      const timer = setTimeout(() => fail(`Theme ${action} was not confirmed by every window within 10 seconds`, 504), ACK_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        pending.delete(requestId);
      };
      pending.set(requestId, {
        action,
        answer(connectionId, result) {
          const client = clients.find((candidate) => candidate.openchamberConnectionId === connectionId);
          if (!client || responses.has(connectionId)) return false;
          if (!getClients().has(client) || client.writableEnded) {
            fail('A theme window disconnected before confirming the request', 503);
            return false;
          }
          if (result.kind === 'error') {
            fail(`Theme request failed in a window: ${result.message}`, 422);
            return true;
          }
          if ((action === 'capabilities' && result.kind !== 'capabilities')
            || (action === 'set' && (result.kind !== 'applied' || result.themeId !== id))) {
            fail('A window returned a mismatched theme acknowledgment', 422);
            return true;
          }
          const response = { connectionId, transparentWindow: result.transparentWindow };
          if (result.kind === 'applied') {
            Object.assign(response, {
              themeId: result.themeId,
              backgroundOpacity: result.backgroundOpacity,
            });
          }
          responses.set(connectionId, response);
          if (responses.size === clients.length) {
            if (clients.some((target) => !getClients().has(target) || target.writableEnded)) {
              fail('A theme window disconnected before every window confirmed the request', 503);
              return true;
            }
            cleanup();
            resolve([...responses.values()]);
          }
          return true;
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      for (const client of clients) {
        if (!pending.has(requestId)) break;
        try {
          const properties = { requestId, connectionId: client.openchamberConnectionId, action };
          if (id) properties.id = id;
          writeEvent(client, {
            type: 'openchamber:theme-control-request',
            properties,
          });
        } catch {
          fail('Could not deliver the theme request to every window', 503);
          break;
        }
      }
    });
  };

  return {
    async capabilities({ signal } = {}) {
      const windows = await request('capabilities', null, signal);
      return {
        protocolVersion: 1,
        customThemes: true,
        backgroundOpacity: true,
        opacityRange: { minExclusive: 0, max: 1 },
        ackTimeoutMs: ACK_TIMEOUT_MS,
        windows,
      };
    },
    async set(id, { signal } = {}) {
      const applied = await request('set', id, signal);
      return { id, delivered: applied.length, applied };
    },
    answer(input) {
      const parsed = resultSchema.safeParse(input);
      if (!parsed.success) throw new OpenChamberControlError('Invalid theme acknowledgment', 400);
      const { requestId, connectionId, result } = parsed.data;
      return { matched: pending.get(requestId)?.answer(connectionId, result) ?? false };
    },
  };
};
