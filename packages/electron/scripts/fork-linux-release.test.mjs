import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareArchRecipe, verifyForkInventory } from './fork-linux-release.mjs';

const version = '2.5.2';
const sourceCommit = 'a'.repeat(40);
const directoryFor = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fork-linux-release-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};
const writeInventory = async (directory) => {
  await fs.writeFile(path.join(directory, 'PKGBUILD'), 'pinned recipe');
  await fs.writeFile(path.join(directory, 'LICENSE'), 'license');
  await fs.writeFile(path.join(directory, `openchamber-desktop-${version}-1-x86_64.pkg.tar.zst`), 'arch package');
  for (const [arch, image, deb, rpm, manifest] of [
    ['x64', 'x86_64', 'amd64', 'x86_64', 'latest-linux.yml'],
    ['arm64', 'arm64', 'arm64', 'aarch64', 'latest-linux-arm64.yml'],
  ]) {
    const entries = [];
    for (const [suffix, extension] of [[image, 'AppImage'], [deb, 'deb'], [rpm, 'rpm']]) {
      const name = `OpenChamber-${version}-linux-${suffix}.${extension}`;
      const bytes = Buffer.from(`fixture ${name}`);
      await fs.writeFile(path.join(directory, name), bytes);
      entries.push(`  - url: ${name}\n    sha512: ${createHash('sha512').update(bytes).digest('base64')}\n    size: ${bytes.length}`);
    }
    await fs.writeFile(path.join(directory, manifest), `version: ${version}\nfiles:\n${entries.join('\n')}\n`);
  }
  for (const arch of ['x64', 'arm64', 'arch']) {
    await fs.writeFile(path.join(directory, `theme-control-${arch}.json`), JSON.stringify({
      platform: 'linux', architecture: arch === 'arm64' ? 'arm64' : 'x64', nativeTransparency: true,
      checks: ['two-window application, persistence and same-ID opacity reload', 'missing themes and zero opacity refused'],
    }));
  }
};

test('Arch recipe pins the exact DEB, source license and commit without claiming DEB updater support', async (t) => {
  const root = await directoryFor(t);
  const debPath = path.join(root, `OpenChamber-${version}-linux-amd64.deb`);
  await fs.writeFile(debPath, 'deb bytes');
  const directory = path.join(root, 'recipe');
  await prepareArchRecipe({ debPath, directory, version, sourceCommit });
  const recipe = await fs.readFile(path.join(directory, 'PKGBUILD'), 'utf8');
  assert(recipe.includes(createHash('sha256').update('deb bytes').digest('hex')));
  const license = await fs.readFile(path.join(directory, 'LICENSE'));
  assert(recipe.includes(createHash('sha256').update(license).digest('hex')));
  assert(recipe.includes(`/${sourceCommit}/LICENSE`));
  assert(recipe.includes("printf 'arch\\n'"));
  assert(recipe.includes('test ! -L "${pkgdir}/usr/bin/openchamber"'));
  assert(!recipe.includes('SKIP'));
  assert(!/@[A-Z_]+@/.test(recipe));
  await assert.rejects(prepareArchRecipe({ debPath, directory, version, sourceCommit }), { code: 'EEXIST' });
});

test('recipe refuses malformed provenance and wrong-architecture payloads before writing', async (t) => {
  const root = await directoryFor(t);
  const directory = path.join(root, 'recipe');
  await assert.rejects(prepareArchRecipe({ debPath: 'wrong.deb', directory, version, sourceCommit: 'bad' }));
  await assert.rejects(prepareArchRecipe({ debPath: 'wrong.deb', directory, version, sourceCommit }));
  await assert.rejects(fs.access(directory), { code: 'ENOENT' });
});

test('complete dual-architecture inventory records exact checksums and remaining release gates', async (t) => {
  const directory = await directoryFor(t);
  await writeInventory(directory);
  await verifyForkInventory({ directory, version, sourceCommit });
  const sums = (await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  assert.equal(sums.length, 14);
  for (const line of sums) {
    const [checksum, name] = line.split('  ');
    const bytes = await fs.readFile(path.join(directory, name));
    assert.equal(checksum, createHash('sha256').update(bytes).digest('hex'));
  }
  const provenance = JSON.parse(await fs.readFile(path.join(directory, 'provenance.json'), 'utf8'));
  assert.equal(provenance.sourceCommit, sourceCommit);
  assert.deepEqual(provenance.externalReleaseGates, ['Nobara runtime', 'AppImage update and shutdown', 'HMR development']);
});

test('inventory rejects a corrupt payload before writing release checksums', async (t) => {
  const directory = await directoryFor(t);
  await writeInventory(directory);
  await fs.appendFile(path.join(directory, `OpenChamber-${version}-linux-amd64.deb`), 'corrupted');
  await assert.rejects(verifyForkInventory({ directory, version, sourceCommit }), /size mismatch/);
  await assert.rejects(fs.access(path.join(directory, 'SHA256SUMS')), { code: 'ENOENT' });
});

test('inventory rejects omitted assets, unexpected files and failed or wrong-architecture runtime evidence', async (t) => {
  for (const change of ['missing', 'extra', 'failed', 'architecture']) {
    const directory = await directoryFor(t);
    await writeInventory(directory);
    if (change === 'missing') await fs.unlink(path.join(directory, 'PKGBUILD'));
    if (change === 'extra') await fs.writeFile(path.join(directory, 'unexpected.txt'), 'unexpected');
    if (change === 'failed' || change === 'architecture') {
      const name = path.join(directory, 'theme-control-arch.json');
      const report = JSON.parse(await fs.readFile(name, 'utf8'));
      if (change === 'failed') report.error = 'native fixture failed';
      else report.architecture = 'arm64';
      await fs.writeFile(name, JSON.stringify(report));
    }
    await assert.rejects(verifyForkInventory({ directory, version, sourceCommit }));
    await assert.rejects(fs.access(path.join(directory, 'SHA256SUMS')), { code: 'ENOENT' });
  }
});
