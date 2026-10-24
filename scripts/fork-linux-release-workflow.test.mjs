import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from 'yaml';

const workflow = yaml.parse(fs.readFileSync(new URL('../.github/workflows/release-fork-linux.yml', import.meta.url), 'utf8'));

test('fork Linux builds use standard native runners and the Ubuntu 22.04 userspace', () => {
  assert.equal(workflow.jobs.build.if, "${{ github.repository == 'KonTy/openchamber' }}");
  assert.equal(workflow.jobs.build.container, 'ubuntu:22.04');
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map(({ runner, arch }) => [runner, arch]), [
    ['ubuntu-24.04', 'x64'], ['ubuntu-24.04-arm', 'arm64'],
  ]);
  assert.equal(workflow.jobs.arch.container, 'archlinux:base-devel');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
});

test('draft creation requires the maintained branch and explicit dispatch and cannot publish automatically', () => {
  assert.equal(workflow.jobs.draft.if, "${{ github.repository == 'KonTy/openchamber' && github.event_name == 'workflow_dispatch' && inputs.draft_release && github.ref == 'refs/heads/work-theme-integration-baseline' }}");
  assert.deepEqual(workflow.jobs.draft.needs, 'inventory');
  const publication = workflow.jobs.draft.steps.find((step) => step.run)?.run;
  assert(publication.includes('gh release create "v$VERSION" --draft'));
  assert(publication.includes('sha256sum --check SHA256SUMS'));
  assert(publication.includes('test "$SOURCE" = "$GITHUB_SHA"'));
  assert(!publication.includes('gh release edit'));
});

test('both distro installs preserve an existing CLI and run two-window native validation', () => {
  for (const job of [workflow.jobs.build, workflow.jobs.arch]) {
    const install = job.steps.find((step) => step.name?.startsWith('Install and exercise'));
    assert(install.run.includes('CLI_SHA=$(sha256sum /usr/bin/openchamber)'));
    assert(install.run.includes('test "$(sha256sum /usr/bin/openchamber)" = "$CLI_SHA"'));
    assert(install.run.includes('scripts/smoke-theme-control.mjs'));
  }
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
    }
  }
});

test('Nobara validation installs its real release packages and preserves signature checks', () => {
  const containerfile = fs.readFileSync(new URL('../packages/electron/resources/linux/Containerfile.nobara', import.meta.url), 'utf8');
  assert(containerfile.includes('sha256sum --check'));
  assert(containerfile.includes('rpmkeys --checksig'));
  assert(containerfile.includes('--setopt=bootstrap.gpgcheck=1'));
  assert(containerfile.includes('swap --allowerasing fedora-release-identity-container'));
  assert(!containerfile.includes('--nogpgcheck'));
  assert(!containerfile.includes('gpgcheck=0'));
  assert.deepEqual(workflow.jobs.inventory.needs, ['build', 'arch', 'nobara']);
  const install = workflow.jobs.nobara.steps.find((step) => step.name === 'Install and exercise the Nobara RPM');
  assert(install.run.includes('test "$(sha256sum /usr/bin/openchamber)" = "$CLI_SHA"'));
  assert(install.run.includes('scripts/smoke-theme-control.mjs'));
});
