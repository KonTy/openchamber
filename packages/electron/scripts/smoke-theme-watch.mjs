import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CdpClient } from '../../../scripts/perf/cdp.mjs';

const { values } = parseArgs({ options: {
  executable: { type: 'string' },
  directory: { type: 'string' },
  report: { type: 'string' },
  framed: { type: 'boolean', default: false },
  opaque: { type: 'boolean', default: false },
  development: { type: 'boolean', default: false },
  bundled: { type: 'boolean', default: false },
} });
assert(values.directory && values.report, 'Supply --directory and --report');
assert(Boolean(values.executable) !== values.development, 'Supply either --executable or --development');
assert(!values.bundled || values.development, '--bundled requires --development');
const hmr = values.development && !values.bundled;
if (values.executable) await fs.access(path.resolve(values.executable));
const root = path.resolve(values.directory);
await fs.mkdir(root, { recursive: false, mode: 0o700 });
const data = path.join(root, 'data');
const profile = path.join(root, 'electron');
const password = randomUUID();
const fixture = JSON.parse(await fs.readFile(new URL('../../ui/src/lib/theme/themes/openchamber-dark.json', import.meta.url), 'utf8'));
fixture.metadata.id = 'fixture-watched-theme';
fixture.config = { ...fixture.config, backgroundOpacity: 1 };
const themesDir = path.join(data, 'themes');
await fs.mkdir(themesDir, { recursive: true });
const themeFile = path.join(themesDir, `${fixture.metadata.id}.json`);
await fs.writeFile(themeFile, JSON.stringify(fixture));
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({
  desktopLinuxNativeFrame: values.framed,
  desktopUiPassword: password,
  desktopLanAccessEnabled: false,
  desktopDefaultHostId: 'local',
  themeId: fixture.metadata.id,
  darkThemeId: fixture.metadata.id,
  themeVariant: 'dark',
  useSystemTheme: false,
}), { mode: 0o600 });
const expectedAlpha = !values.framed && !values.opaque;
const environment = {
  ...Object.fromEntries([
    'PATH', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
    'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR',
  ].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
  HOME: path.join(root, 'home'),
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
  XDG_DATA_HOME: path.join(root, 'share'),
  XDG_STATE_HOME: path.join(root, 'state'),
  OPENCHAMBER_DATA_DIR: data,
  OPENCHAMBER_DESKTOP_USER_DATA_DIR: profile,
  OPENCHAMBER_RELAY_HOST: 'off',
  OPENCODE_CONFIG_DIR: path.join(root, 'opencode'),
};
if (values.opaque) environment.OPENCHAMBER_TRANSPARENT_WINDOW = '0';
if (values.development) {
  environment.OPENCHAMBER_ELECTRON_REMOTE_DEBUGGING_PORT = '0';
  environment.OPENCHAMBER_HMR_UI_PORT = '0';
  environment.OPENCHAMBER_HMR_API_PORT = '0';
  environment.OPENCHAMBER_TRANSPARENT_WINDOW = expectedAlpha ? '1' : '0';
  environment.OPENCHAMBER_UI_PASSWORD = password;
  if (values.bundled) environment.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI = '1';
}
await fs.mkdir(environment.HOME, { recursive: true });
const log = await fs.open(path.join(root, 'native.log'), 'w');
const appArguments = [
  '--remote-debugging-port=0', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=MacAppCodeSignClone',
  ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
];
const child = spawn(values.development ? process.execPath : path.resolve(values.executable),
  values.development ? [fileURLToPath(new URL('./electron-dev.mjs', import.meta.url))] : appArguments,
  { cwd: environment.HOME, env: environment, stdio: ['ignore', log.fd, log.fd] });
let startupError;
const exit = once(child, 'exit').catch((error) => { startupError = error; });
const clients = [];
const checks = [];
const assetFailures = [];
const latenciesMs = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (probe, description) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    assert.equal(assetFailures.length, 0, JSON.stringify(assetFailures));
    assert(child.exitCode === null && child.signalCode === null, 'Isolated app exited');
    const result = await probe();
    if (result) return result;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}; native log is ${path.join(root, 'native.log')}`);
};
const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { timeoutMs: 20_000 });
  assert(!response.exceptionDetails, response.exceptionDetails?.exception?.description || response.exceptionDetails?.text);
  return response.result.value;
};
const request = (client, route, body) => evaluate(client, `(async () => {
  const base = window.__OPENCHAMBER_API_BASE_URL__ || ${hmr ? 'window.location.origin' : 'null'};
  if (!base) return null;
  const token = ${hmr ? 'null' : `window.__OPENCHAMBER_CLIENT_TOKEN__
    || await window.__OPENCHAMBER_DESKTOP__.invoke('desktop_local_client_token_get')`};
  const response = await fetch(new URL(${JSON.stringify(route)}, base), {
    method: ${JSON.stringify(body ? 'POST' : 'GET')},
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
    ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''}
  });
  return { status: response.status, body: response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : null };
})()`);
const isApplicationPage = (page) => page.type === 'page' && !page.url.includes('__splash')
  && (hmr ? /^http:\/\/127\.0\.0\.1:\d+\//.test(page.url) : page.url.startsWith('openchamber-ui://app'));
const observe = async (target) => {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  clients.push(client);
  await client.connect();
  const assets = new Map();
  client.on('Network.requestWillBeSent', ({ request: resource, requestId }) => {
    if (resource.url.startsWith('openchamber-ui://app/assets/')) assets.set(requestId, resource.url);
    if (resource.url.includes('/api/openchamber/theme/result')) assetFailures.push({ url: resource.url, errorText: 'Removed theme callback was called' });
  });
  client.on('Network.loadingFailed', ({ requestId, errorText, canceled }) => {
    if (!canceled && assets.has(requestId)) assetFailures.push({ url: assets.get(requestId), errorText });
    assets.delete(requestId);
  });
  client.on('Network.loadingFinished', ({ requestId }) => assets.delete(requestId));
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  return client;
};
const snapshot = (client) => evaluate(client, `(() => {
  const root = document.getElementById('root');
  const style = getComputedStyle(root);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  context.fillStyle = style.getPropertyValue('--background').trim();
  context.fillRect(0, 0, 1, 1);
  return {
    selected: JSON.parse(localStorage.getItem('openchamber.theme.v2:local')),
    primary: style.getPropertyValue('--primary-base').trim(),
    alpha: context.getImageData(0, 0, 1, 1).data[3],
    transparentWindow: window.__OPENCHAMBER_ELECTRON__?.transparentWindow === true,
  };
})()`);
try {
  const port = await until(async () => {
    try { return Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, 'the isolated CDP port');
  const pages = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = await until(async () => (await pages()).find(isApplicationPage), 'the application renderer');
  const client = await observe(target);
  await until(() => evaluate(client, 'Boolean(document.querySelector("#openchamber-ui-password"))'), 'the native sign-in form');
  await evaluate(client, 'document.querySelector("#openchamber-ui-password").focus()');
  await client.send('Input.insertText', { text: password });
  await evaluate(client, 'document.querySelector("#openchamber-ui-password").form.requestSubmit()');
  await until(() => evaluate(client, 'window.__openchamberAppReady === true'), 'the usable application');
  for (const action of ['theme.set', 'theme.capabilities']) {
    const refused = await request(client, '/api/openchamber/control', { action, input: { id: fixture.metadata.id } });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Unsupported OpenChamber action/);
  }
  checks.push('removed theme API actions refused');
  await evaluate(client, hmr
    ? 'window.__OPENCHAMBER_DESKTOP__.invoke("desktop_new_window_at_url", { url: window.location.origin })'
    : 'window.__OPENCHAMBER_DESKTOP__.invoke("desktop_new_window")');
  const second = await until(async () => (await pages()).find((page) => page.id !== target.id && isApplicationPage(page)), 'the second native window');
  const secondClient = await observe(second);
  await until(() => evaluate(secondClient, 'window.__openchamberAppReady === true'), 'the usable second application');
  await until(async () => (await Promise.all(clients.map(snapshot))).every((state) => state.selected?.darkThemeId === fixture.metadata.id), 'the initially selected custom theme');
  const preferencesBefore = await fs.readFile(path.join(data, 'preferences.json'));
  const alternate = JSON.parse(await fs.readFile(new URL('../../ui/src/lib/theme/themes/openchamber-light.json', import.meta.url), 'utf8'));
  for (const [index, opacity] of [0.5, 0.75, 1].entries()) {
    fixture.config.backgroundOpacity = opacity;
    fixture.colors.primary.base = index % 2 === 0 ? alternate.colors.primary.base : '#abcdef';
    const started = Date.now();
    const temporary = `${themeFile}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(fixture));
    await fs.rename(temporary, themeFile);
    await until(async () => {
      const states = await Promise.all(clients.map(snapshot));
      return states.every((state) => state.primary === fixture.colors.primary.base
        && state.alpha === Math.round((expectedAlpha ? opacity : 1) * 255));
    }, 'both windows applying an atomic same-ID theme edit');
    latenciesMs.push(Date.now() - started);
    for (const state of await Promise.all(clients.map(snapshot))) {
      assert.equal(state.transparentWindow, expectedAlpha);
      assert.equal(state.selected.darkThemeId, fixture.metadata.id);
      assert.equal(state.selected.themeMode, 'dark');
    }
  }
  assert.deepEqual(await fs.readFile(path.join(data, 'preferences.json')), preferencesBefore);
  checks.push('two-window same-ID palette and opacity reload without selection writes');
  fixture.config.backgroundOpacity = 0;
  await fs.writeFile(themeFile, JSON.stringify(fixture));
  const library = await request(client, '/api/config/themes');
  assert.equal(library.status, 200);
  const retained = library.body.themes.find((theme) => theme.metadata.id === fixture.metadata.id);
  assert.equal(retained.config.backgroundOpacity, 1);
  const invalidTheme = { ...fixture, metadata: { ...fixture.metadata, id: 'fixture-invalid-theme' } };
  await fs.writeFile(path.join(themesDir, 'invalid.json'), JSON.stringify(invalidTheme));
  const invalidLibrary = await request(client, '/api/config/themes');
  assert.equal(invalidLibrary.status, 200);
  assert(!invalidLibrary.body.themes.some((theme) => theme.metadata.id === invalidTheme.metadata.id));
  checks.push('invalid custom theme skipped');
  fixture.config.backgroundOpacity = 0.8;
  fixture.colors.primary.base = '#abcdef';
  await fs.writeFile(themeFile, JSON.stringify(fixture));
  await until(async () => (await Promise.all(clients.map(snapshot))).every((state) =>
    state.primary === fixture.colors.primary.base && state.alpha === Math.round((expectedAlpha ? 0.8 : 1) * 255)), 'recovery after an invalid selected theme edit');
  checks.push('invalid selected theme retains last valid palette and recovers');
  await fs.writeFile(path.resolve(values.report), JSON.stringify({
    platform: process.platform, architecture: process.arch, framed: values.framed,
    ui: hmr ? 'hmr' : 'bundled', nativeTransparency: expectedAlpha,
    checks, latenciesMs, compositorRendering: 'unmeasured',
  }, null, 2) + '\n');
  console.log(`Theme watcher passed ${checks.length} native checks; transparentWindow=${expectedAlpha}`);
} catch (error) {
  await fs.writeFile(path.resolve(values.report), JSON.stringify({
    checks, error: error.message, assetFailures, latenciesMs,
  }, null, 2) + '\n');
  throw error;
} finally {
  for (const client of clients) client.close();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  try { await exit; } finally { clearTimeout(timer); await log.close(); }
}
