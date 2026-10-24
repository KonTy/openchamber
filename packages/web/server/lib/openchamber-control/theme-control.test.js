import { afterEach, describe, expect, it, vi } from 'vitest';
import { createThemeControl } from './theme-control.js';

const fixture = () => {
  const one = { openchamberConnectionId: 'one', openchamberThemeCapable: true };
  const two = { openchamberConnectionId: 'two', openchamberThemeCapable: true };
  const clients = new Set([one, two]);
  const sent = [];
  const control = createThemeControl({
    getClients: () => clients,
    writeEvent: (client, event) => sent.push({ client, ...event.properties }),
  });
  const answer = (index, result) => {
    const { requestId, connectionId } = sent[index];
    return control.answer({ requestId, connectionId, result });
  };
  return { clients, one, two, sent, control, answer };
};

afterEach(() => vi.useRealTimers());

describe('theme control acknowledgments', () => {
  it('probes each live handler and preserves opaque native readiness', async () => {
    const { control, answer } = fixture();
    const result = control.capabilities();
    answer(0, { kind: 'capabilities', transparentWindow: true });
    answer(1, { kind: 'capabilities', transparentWindow: false });
    await expect(result).resolves.toEqual({
      protocolVersion: 1, customThemes: true, backgroundOpacity: true,
      opacityRange: { minExclusive: 0, max: 1 }, ackTimeoutMs: 10000,
      windows: [{ connectionId: 'one', transparentWindow: true }, { connectionId: 'two', transparentWindow: false }],
    });
  });

  it('requires every targeted window and ignores duplicate, foreign and expired answers', async () => {
    const { control, answer, sent } = fixture();
    let finished = false;
    const result = control.set('fixture').then((value) => { finished = true; return value; });
    const applied = { kind: 'applied', themeId: 'fixture', backgroundOpacity: 0.5, transparentWindow: true };
    expect(control.answer({ requestId: sent[0].requestId, connectionId: 'foreign', result: applied })).toEqual({ matched: false });
    expect(answer(0, applied)).toEqual({ matched: true });
    expect(answer(0, applied)).toEqual({ matched: false });
    await Promise.resolve();
    expect(finished).toBe(false);
    answer(1, applied);
    await expect(result).resolves.toMatchObject({ id: 'fixture', delivered: 2, applied: [{ connectionId: 'one' }, { connectionId: 'two' }] });
    expect(answer(1, applied)).toEqual({ matched: false });
  });

  it.each([
    [{ kind: 'error', message: 'Settings write failed' }, 'failed in a window'],
    [{ kind: 'applied', themeId: 'wrong', backgroundOpacity: 1, transparentWindow: false }, 'mismatched'],
    [{ kind: 'capabilities', transparentWindow: true }, 'mismatched'],
  ])('rejects an unsuccessful set acknowledgment', async (response, message) => {
    const { control, answer } = fixture();
    const result = control.set('fixture');
    const rejected = expect(result).rejects.toMatchObject({ statusCode: 422, partial: true, message: expect.stringContaining(message) });
    answer(0, response);
    await rejected;
  });

  it('times out, cancels and detects disconnection without reporting successful application', async () => {
    vi.useFakeTimers();
    const { control, clients, one, answer } = fixture();
    const timeout = expect(control.set('fixture')).rejects.toMatchObject({ statusCode: 504, partial: true });
    await vi.advanceTimersByTimeAsync(10000);
    await timeout;
    expect(answer(0, { kind: 'capabilities', transparentWindow: true })).toEqual({ matched: false });
    const abort = new AbortController();
    const cancelled = expect(control.set('fixture', { signal: abort.signal })).rejects.toMatchObject({ statusCode: 499 });
    abort.abort();
    await cancelled;
    const disconnected = expect(control.set('fixture')).rejects.toMatchObject({ statusCode: 503, partial: true });
    clients.delete(one);
    answer(4, { kind: 'applied', themeId: 'fixture', backgroundOpacity: 1, transparentWindow: false });
    await disconnected;
  });

  it('rejects zero opacity and absent handlers', async () => {
    const { control, clients, sent } = fixture();
    const result = control.set('fixture');
    expect(() => control.answer({
      requestId: sent[0].requestId, connectionId: 'one',
      result: { kind: 'applied', themeId: 'fixture', backgroundOpacity: 0, transparentWindow: true },
    })).toThrow('Invalid theme acknowledgment');
    control.answer({ requestId: sent[0].requestId, connectionId: 'one', result: { kind: 'error', message: 'invalid' } });
    await expect(result).rejects.toMatchObject({ statusCode: 422 });
    clients.clear();
    await expect(control.capabilities()).rejects.toMatchObject({ statusCode: 503 });
  });

  it('refuses success if an earlier responding window disconnected during the request', async () => {
    const { control, clients, one, answer } = fixture();
    const result = expect(control.set('fixture')).rejects.toMatchObject({ statusCode: 503, partial: true });
    const applied = { kind: 'applied', themeId: 'fixture', backgroundOpacity: 1, transparentWindow: false };
    answer(0, applied);
    clients.delete(one);
    answer(1, applied);
    await result;
  });
});
