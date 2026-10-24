import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
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
  'bridge-root': { type: 'string' },
  development: { type: 'boolean', default: false },
} });
assert(values.directory && values.report, 'Supply --directory and --report');
assert(Boolean(values.executable) !== values.development, 'Supply either --executable or --development');
if (values.executable) await fs.access(path.resolve(values.executable));
const root = path.resolve(values.directory);
await fs.mkdir(root, { recursive: false });
const data = path.join(root, 'data');
const profile = path.join(root, 'electron');
const password = randomUUID();
await fs.mkdir(path.join(data, 'themes'), { recursive: true });
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({
  desktopLinuxNativeFrame: values.framed,
  desktopUiPassword: password,
  desktopLanAccessEnabled: false,
  desktopDefaultHostId: 'local',
}));
const fixture = JSON.parse(await fs.readFile(new URL('../../ui/src/lib/theme/themes/openchamber-dark.json', import.meta.url), 'utf8'));
fixture.metadata.id = 'fixture-release-theme';
fixture.config = { ...fixture.config, backgroundOpacity: 0.5 };
const themeFile = path.join(data, 'themes', `${fixture.metadata.id}.json`);
await fs.writeFile(themeFile, JSON.stringify(fixture));
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
let client;
const clients = [];
const themeResults = [];
const themeWarnings = [];
const assetFailures = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (probe, description) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    assert.equal(assetFailures.length, 0, JSON.stringify(assetFailures));
    assert(child.exitCode === null && child.signalCode === null, 'Isolated app exited during startup');
    const result = await probe();
    if (result) return result;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}; native log is ${path.join(root, 'native.log')}`);
};
const rpc = (method, params) => client.send(method, params, { timeoutMs: 20_000 });
const evaluate = async (expression) => {
  const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description
    || result.exceptionDetails?.text || 'Native renderer evaluation failed');
  return result.result.value;
};
const request = (route, body) => evaluate(`(async () => {
  const base = window.__OPENCHAMBER_API_BASE_URL__ || ${values.development ? 'window.location.origin' : 'null'};
  if (!base) return null;
  const token = ${values.development ? 'null' : `window.__OPENCHAMBER_CLIENT_TOKEN__
    || await window.__OPENCHAMBER_DESKTOP__.invoke('desktop_local_client_token_get')`};
  const response = await fetch(new URL(${JSON.stringify(route)}, base), {
    method: ${JSON.stringify(body ? 'POST' : 'GET')},
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
    ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''}
  });
  return {
    status: response.status,
    body: response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : null,
  };
})()`);
const control = (action, input) => request('/api/openchamber/control', { action, input });
const checkProbe = (probe, count) => {
  assert.equal(probe.status, 200);
  assert.equal(probe.body.protocolVersion, 1);
  assert.equal(probe.body.customThemes, true);
  assert.equal(probe.body.backgroundOpacity, true);
  assert.deepEqual(probe.body.opacityRange, { minExclusive: 0, max: 1 });
  assert.equal(probe.body.ackTimeoutMs, 10_000);
  assert.equal(probe.body.windows.length, count);
  assert.equal(new Set(probe.body.windows.map((window) => window.connectionId)).size, count);
  for (const window of probe.body.windows) assert.equal(window.transparentWindow, expectedAlpha);
};
const checks = [];
const isApplicationPage = (page) => page.type === 'page' && !page.url.includes('__splash')
  && (values.development ? /^http:\/\/127\.0\.0\.1:\d+\//.test(page.url) : page.url.startsWith('openchamber-ui://app'));
const observe = async (target) => {
  const connection = new CdpClient(target.webSocketDebuggerUrl);
  const assetRequests = new Map();
  clients.push(connection);
  await connection.connect();
  connection.on('Network.requestWillBeSent', ({ request, requestId }) => {
    if (request.url.startsWith('openchamber-ui://app/assets/')) assetRequests.set(requestId, request.url);
    if (request.url.includes('/api/openchamber/theme/result') && request.postData && themeResults.length < 80) {
      themeResults.push(JSON.parse(request.postData));
    }
  });
  connection.on('Network.loadingFailed', ({ requestId, errorText, canceled }) => {
    if (!canceled && assetRequests.has(requestId) && assetFailures.length < 12) {
      assetFailures.push({ url: assetRequests.get(requestId), errorText });
    }
    assetRequests.delete(requestId);
  });
  connection.on('Network.loadingFinished', ({ requestId }) => assetRequests.delete(requestId));
  connection.on('Runtime.consoleAPICalled', ({ args }) => {
    for (const argument of args) {
      if (argument.type === 'string' && /theme/i.test(argument.value) && themeWarnings.length < 80) {
        themeWarnings.push(argument.value);
      }
    }
  });
  await connection.send('Runtime.enable');
  await connection.send('Network.enable');
  return connection;
};
const checkBridge = async () => {
  const bridgeRoot = path.resolve(values['bridge-root']);
  const current = path.join(environment.HOME, '.config/smplos/current');
  await fs.mkdir(path.join(current, 'theme'), { recursive: true });
  await fs.writeFile(path.join(current, '..', 'openchamber-data-dirs'), `${data}\n`);
  const bridgeLog = await fs.open(path.join(root, 'bridge.log'), 'a');
  const runBridge = async (name) => {
    const sourceTheme = path.join(bridgeRoot, 'src/shared/themes', name);
    const source = path.join(sourceTheme, 'colors.toml');
    await fs.rm(path.join(current, 'theme'), { recursive: true });
    await fs.cp(sourceTheme, path.join(current, 'theme'), { recursive: true });
    await fs.writeFile(path.join(current, 'theme.name'), `${name}\n`);
    const bridgeChild = spawn('python3', [path.join(bridgeRoot, 'src/shared/bin/theme-set-openchamber')], {
      cwd: environment.HOME,
      env: { PATH: environment.PATH, HOME: environment.HOME, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', bridgeLog.fd, bridgeLog.fd],
      timeout: 35_000,
    });
    const [code, signal] = await once(bridgeChild, 'exit');
    assert.equal(signal, null, 'Theme bridge terminated by a signal');
    return { code, source };
  };
  try {
    if (!expectedAlpha) {
      const before = await fs.readFile(path.join(data, 'settings.json'));
      const beforePreferences = await fs.readFile(path.join(data, 'preferences.json'));
      const beforeThemes = await fs.readdir(path.join(data, 'themes'));
      assert.equal((await runBridge('catppuccin')).code, 1);
      assert.deepEqual(await fs.readFile(path.join(data, 'settings.json')), before);
      assert.deepEqual(await fs.readFile(path.join(data, 'preferences.json')), beforePreferences);
      assert.deepEqual(await fs.readdir(path.join(data, 'themes')), beforeThemes);
      await assert.rejects(fs.access(path.join(data, 'themes/smplos-catppuccin.json')), { code: 'ENOENT' });
      await assert.rejects(fs.access(path.join(environment.HOME, '.local/state/smplos/openchamber-theme-backups')), { code: 'ENOENT' });
      checks.push('actual bridge refuses translucent themes before backups or settings/theme writes');
    }
    for (const name of expectedAlpha ? ['amber', 'catppuccin', 'amber'] : ['amber']) {
      const start = themeResults.length;
      const result = await runBridge(name);
      assert.equal(result.code, 0, `Theme bridge failed for ${name}; see the isolated bridge.log`);
      const replies = themeResults.slice(start);
      const probed = replies.filter((reply) => reply.result.kind === 'capabilities');
      const applied = replies.filter((reply) => reply.result.kind === 'applied');
      assert.equal(probed.length, 2, 'The bridge must probe both native windows');
      assert.equal(applied.length, 2, 'The bridge must receive both native application acknowledgments');
      assert.equal(new Set(probed.map((reply) => reply.requestId)).size, 1);
      assert.equal(new Set(applied.map((reply) => reply.requestId)).size, 1);
      assert.deepEqual(applied.map((reply) => reply.connectionId).sort(), probed.map((reply) => reply.connectionId).sort());
      for (const reply of applied) {
        assert.equal(reply.result.themeId, `smplos-${name}`);
        assert.equal(reply.result.backgroundOpacity, name === 'amber' ? 1 : 0.5);
        assert.equal(reply.result.transparentWindow, expectedAlpha);
      }
      const { stdout } = await promisify(execFile)('python3', [
        '-c', 'import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))))', result.source,
      ], { env: { PATH: environment.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
      const palette = JSON.parse(stdout);
      const published = JSON.parse(await fs.readFile(path.join(data, 'themes', `smplos-${name}.json`), 'utf8'));
      assert.equal(published.metadata.id, `smplos-${name}`);
      assert.equal(published.config.backgroundOpacity, name === 'amber' ? 1 : 0.5);
      assert.deepEqual(published.colors, {
        primary: { base: palette.accent },
        surface: {
          background: palette.background, foreground: palette.foreground, muted: palette.surface,
          mutedForeground: palette.muted, elevated: palette.bg_light,
        },
        interactive: { border: palette.bg_lighter },
        status: { error: palette.danger, warning: palette.warning, success: palette.success, info: palette.info },
        syntax: { base: {
          comment: palette.autosuggestion, keyword: palette.accent_alt, string: palette.cursor,
          number: palette.warning, function: palette.accent, variable: palette.foreground,
          type: palette.info_bright, operator: palette.cursor,
        } },
      });
      for (const connection of clients) {
        const snapshot = await connection.send('Runtime.evaluate', {
          expression: `JSON.stringify({
            selected: JSON.parse(localStorage.getItem('openchamber.theme.v2:local')),
            background: getComputedStyle(document.getElementById('root')).getPropertyValue('--surface-background').trim(),
            primary: getComputedStyle(document.getElementById('root')).getPropertyValue('--primary-base').trim(),
          })`,
          returnByValue: true,
        });
        assert(!snapshot.exceptionDetails, 'Could not read a native window theme');
        const rendered = JSON.parse(snapshot.result.value);
        assert.equal(rendered.selected.darkThemeId, `smplos-${name}`);
        assert.equal(rendered.selected.themeMode, 'dark');
        assert.equal(rendered.background, palette.background);
        assert.equal(rendered.primary, palette.accent);
      }
      const durable = JSON.parse(await fs.readFile(path.join(data, 'preferences.json'), 'utf8'));
      assert.equal(durable.fields.themeId.surfaces.desktop.value, `smplos-${name}`);
      assert.equal(durable.fields.darkThemeId.surfaces.desktop.value, `smplos-${name}`);
      assert.equal(durable.fields.useSystemTheme.surfaces.desktop.value, false);
      const saved = await request('/api/config/settings?surface=desktop');
      assert.equal(saved.status, 200);
      assert.equal(saved.body.themeId, `smplos-${name}`);
      assert.equal(saved.body.useSystemTheme, false);
      const probe = await control('theme.capabilities');
      checkProbe(probe, 2);
    }
    checks.push(`actual bridge palette, alpha and two-window persistence: ${expectedAlpha ? 'amber -> catppuccin -> amber' : 'opaque amber'}`);
  } finally {
    await bridgeLog.close();
  }
};
try {
  const port = await until(async () => {
    try { return Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, 'the isolated CDP port');
  const target = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return pages.find(isApplicationPage);
  }, values.development ? 'the HMR renderer' : 'the packaged renderer');
  client = await observe(target);
  await until(() => evaluate(values.development
    ? 'Boolean(window.__OPENCHAMBER_DESKTOP__)'
    : 'Boolean(window.__OPENCHAMBER_API_BASE_URL__)'), 'the local runtime bootstrap');
  const denied = await evaluate(`(async () => {
    const base = window.__OPENCHAMBER_API_BASE_URL__ || ${values.development ? 'window.location.origin' : 'null'};
    const response = await fetch(new URL('/api/openchamber/control', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'theme.capabilities' }),
    });
    return response.status;
  })()`);
  assert.equal(denied, 401);
  await until(() => evaluate('Boolean(document.querySelector("#openchamber-ui-password"))'), 'the native sign-in form');
  await evaluate('document.querySelector("#openchamber-ui-password").focus()');
  await rpc('Input.insertText', { text: password });
  await evaluate('document.querySelector("#openchamber-ui-password").form.requestSubmit()');
  checks.push('anonymous access refused and native fixture authenticated');
  await until(async () => {
    const health = await request('/health');
    return health?.status === 200 && health.body?.isOpenCodeReady === true && health.body?.openCodeRunning === true;
  }, 'the isolated managed runtime');
  await until(() => evaluate('window.__openchamberAppReady === true'), 'the usable local application');
  const probe = await until(async () => {
    const response = await control('theme.capabilities');
    return response?.status === 200 ? response : null;
  }, 'the mounted native theme handler');
  checkProbe(probe, 1);
  checks.push('native readiness and capability protocol');
  await evaluate(values.development
    ? 'window.__OPENCHAMBER_DESKTOP__.invoke("desktop_new_window_at_url", { url: window.location.origin })'
    : 'window.__OPENCHAMBER_DESKTOP__.invoke("desktop_new_window")');
  const two = await until(async () => {
    const response = await control('theme.capabilities');
    return response?.status === 200 && response.body.windows.length === 2 ? response : null;
  }, 'both native handlers');
  checkProbe(two, 2);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const second = pages.find((page) => page.id !== target.id && isApplicationPage(page));
  assert(second, 'Expected the second native window');
  const secondClient = await observe(second);
  await until(async () => {
    const response = await secondClient.send('Runtime.evaluate', {
      expression: 'window.__openchamberAppReady === true', returnByValue: true,
    });
    return response.result.value === true;
  }, 'the usable second local application');
  if (values['bridge-root']) await checkBridge();
  for (const opacity of [0.5, 0.75, 1]) {
    fixture.config.backgroundOpacity = opacity;
    await fs.writeFile(themeFile, JSON.stringify(fixture));
    const currentProbe = await control('theme.capabilities');
    checkProbe(currentProbe, 2);
    const ids = currentProbe.body.windows.map((window) => window.connectionId).sort();
    const applied = await control('theme.set', { id: fixture.metadata.id });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.delivered, 2);
    assert.deepEqual(applied.body.applied.map((window) => window.connectionId).sort(), ids);
    for (const window of applied.body.applied) {
      assert.equal(window.themeId, fixture.metadata.id);
      assert.equal(window.backgroundOpacity, expectedAlpha ? opacity : 1);
      assert.equal(window.transparentWindow, expectedAlpha);
    }
    const saved = await request('/api/config/settings?surface=desktop');
    assert.equal(saved.status, 200);
    assert.equal(saved.body.themeId, fixture.metadata.id);
    assert.equal(saved.body.useSystemTheme, false);
  }
  checks.push('two-window application, persistence and same-ID opacity reload');
  const missing = await control('theme.set', { id: 'missing-release-theme' });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.partial, true);
  fixture.config.backgroundOpacity = 0;
  await fs.writeFile(themeFile, JSON.stringify(fixture));
  const invalid = await control('theme.set', { id: fixture.metadata.id });
  assert.equal(invalid.status, 422);
  checks.push('missing themes and zero opacity refused');
  await fs.writeFile(path.resolve(values.report), JSON.stringify({
    platform: process.platform, architecture: process.arch, framed: values.framed,
    ui: values.development ? 'hmr' : 'bundled',
    nativeTransparency: expectedAlpha, checks, themeResults, themeWarnings, compositorRendering: 'unmeasured',
  }, null, 2) + '\n');
  console.log(`Theme control passed ${checks.length} native checks; transparentWindow=${expectedAlpha}`);
} catch (error) {
  const windows = [];
  for (const connection of clients) {
    const snapshot = await connection.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        url: window.location.href,
        ready: window.__openchamberAppReady === true,
        bodyText: document.body.innerText.slice(0, 1600),
        selectedThemeId: localStorage.getItem('selectedThemeId'),
        themeMode: localStorage.getItem('themeMode'),
        background: getComputedStyle(document.getElementById('root')).getPropertyValue('--surface-background'),
      })`,
      returnByValue: true,
    }, { timeoutMs: 5_000 });
    windows.push(snapshot.result?.value);
  }
  await fs.writeFile(path.resolve(values.report), JSON.stringify({
    checks, error: error.message, themeResults, themeWarnings, assetFailures, windows,
  }, null, 2) + '\n');
  throw error;
} finally {
  for (const connection of clients) connection.close();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  try { await exit; } finally { clearTimeout(timer); await log.close(); }
}
