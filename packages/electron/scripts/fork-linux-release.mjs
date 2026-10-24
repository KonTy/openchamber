import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyUpdateManifest } from './verify-update-manifest.mjs';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const validateSource = (sourceCommit) => assert.match(sourceCommit, /^[a-f0-9]{40}$/, 'Supply the complete source commit');
const validateVersion = (version) => assert.match(version, /^\d+\.\d+\.\d+$/, 'Fork releases require a stable numeric version');
const sha256 = async (filePath) => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};

export const prepareArchRecipe = async ({ debPath, directory, version, sourceCommit }) => {
  validateSource(sourceCommit);
  validateVersion(version);
  assert.equal(path.basename(debPath), `OpenChamber-${version}-linux-amd64.deb`);
  const licensePath = path.join(workspaceRoot, 'LICENSE');
  const replacements = {
    VERSION: version,
    SOURCE_COMMIT: sourceCommit,
    DEB_SHA256: await sha256(debPath),
    LICENSE_SHA256: await sha256(licensePath),
  };
  const template = await readFile(new URL('../resources/linux/PKGBUILD.in', import.meta.url), 'utf8');
  const recipe = template.replace(/@([A-Z0-9_]+)@/g, (_, key) => {
    assert(Object.hasOwn(replacements, key), `Unknown PKGBUILD field ${key}`);
    return replacements[key];
  });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'PKGBUILD'), recipe, { flag: 'wx' });
  await writeFile(path.join(directory, 'LICENSE'), await readFile(licensePath), { flag: 'wx' });
};

export const verifyForkInventory = async ({ directory, version, sourceCommit }) => {
  validateSource(sourceCommit);
  validateVersion(version);
  const expected = ['PKGBUILD', 'LICENSE', `openchamber-desktop-${version}-1-x86_64.pkg.tar.zst`];
  for (const [arch, imageArch, debArch, rpmArch, manifest] of [
    ['x64', 'x86_64', 'amd64', 'x86_64', 'latest-linux.yml'],
    ['arm64', 'arm64', 'arm64', 'aarch64', 'latest-linux-arm64.yml'],
  ]) {
    const artifacts = [
      `OpenChamber-${version}-linux-${imageArch}.AppImage`,
      `OpenChamber-${version}-linux-${debArch}.deb`,
      `OpenChamber-${version}-linux-${rpmArch}.rpm`,
    ];
    verifyUpdateManifest({
      manifestPath: path.join(directory, manifest),
      artifactPaths: artifacts.map((name) => path.join(directory, name)),
      expectedVersion: version,
    });
    expected.push(...artifacts, manifest, `theme-control-${arch}.json`);
  }
  expected.push('theme-control-arch.json');
  assert.deepEqual((await readdir(directory)).sort(), expected.sort(), 'Release inventory is incomplete or contains unexpected files');
  for (const arch of ['x64', 'arm64', 'arch']) {
    const result = JSON.parse(await readFile(path.join(directory, `theme-control-${arch}.json`), 'utf8'));
    assert.equal(result.platform, 'linux');
    assert.equal(result.architecture, arch === 'arm64' ? 'arm64' : 'x64');
    assert.equal(result.nativeTransparency, true);
    assert(result.checks.includes('two-window application, persistence and same-ID opacity reload'));
    assert(result.checks.includes('missing themes and zero opacity refused'));
    assert.equal(result.error, undefined);
  }
  const checksums = [];
  for (const name of expected) {
    const filePath = path.join(directory, name);
    assert(fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0, `Empty or invalid release asset ${name}`);
    checksums.push(`${await sha256(filePath)}  ${name}`);
  }
  await writeFile(path.join(directory, 'SHA256SUMS'), `${checksums.join('\n')}\n`, { flag: 'wx' });
  await writeFile(path.join(directory, 'provenance.json'), `${JSON.stringify({
    repository: 'KonTy/openchamber', sourceCommit, version,
    buildUserspace: 'Ubuntu 22.04', architectures: ['x64', 'arm64'],
    archPackage: 'x86_64', compositorRendering: 'unmeasured',
    externalReleaseGates: ['Nobara runtime', 'AppImage update and shutdown', 'HMR development'],
  }, null, 2)}\n`, { flag: 'wx' });
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, sourceCommit, debPath] = process.argv.slice(2);
  const { version } = JSON.parse(await readFile(path.join(workspaceRoot, 'package.json'), 'utf8'));
  assert(directory, 'Supply an output directory');
  if (command === 'arch-recipe') await prepareArchRecipe({ directory, sourceCommit, debPath, version });
  else {
    assert.equal(command, 'verify', 'Use arch-recipe or verify');
    await verifyForkInventory({ directory, sourceCommit, version });
  }
}
