import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldUseLinuxTransparency } from './linux-window-transparency.mjs';

test('fork Linux packages enable native alpha without a global environment change', () => {
  const packaged = { platform: 'linux', frameless: true, packaged: true, forkDefault: true };
  assert.equal(shouldUseLinuxTransparency(packaged), true);
  assert.equal(shouldUseLinuxTransparency({ ...packaged, requested: '0' }), false);
  assert.equal(shouldUseLinuxTransparency({ ...packaged, requested: 'invalid' }), false);
  assert.equal(shouldUseLinuxTransparency({ ...packaged, frameless: false, requested: '1' }), false);
  assert.equal(shouldUseLinuxTransparency({ ...packaged, platform: 'darwin', requested: '1' }), false);
  assert.equal(shouldUseLinuxTransparency({ ...packaged, platform: 'win32', requested: '1' }), false);
  assert.equal(shouldUseLinuxTransparency({ ...packaged, forkDefault: false }), false);
  assert.equal(shouldUseLinuxTransparency({ ...packaged, packaged: false }), false);
  assert.equal(shouldUseLinuxTransparency({ ...packaged, packaged: false, requested: '1' }), true);
});
