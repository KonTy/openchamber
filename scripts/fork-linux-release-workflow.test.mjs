import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from 'yaml';

const workflow = yaml.parse(fs.readFileSync(new URL('../.github/workflows/release-fork-linux.yml', import.meta.url), 'utf8'));

test('fork Linux builds use standard native runners and the Ubuntu 22.04 userspace', () => {
  assert.equal(workflow.jobs.build.if, "${{ github.repository == 'KonTy/openchamber' && !inputs.verified_run_id }}");
  assert.equal(workflow.jobs.build.container.image, 'ubuntu:22.04');
  assert.equal(workflow.jobs.build.container.options, '--shm-size=1g --volume /etc/ssl/certs/ca-certificates.crt:/tmp/openchamber-build-ca.crt:ro');
  const tools = workflow.jobs.build.steps.find((step) => step.name === 'Install build and desktop runtime tools');
  assert(tools.run.includes('zlib1g-dev'));
  assert(tools.run.includes('cp /tmp/openchamber-build-ca.crt /etc/ssl/certs/ca-certificates.crt'));
  assert(tools.run.includes("sed -i 's|http://|https://|g' /etc/apt/sources.list"));
  assert(tools.run.includes('APT::Update::Error-Mode=any'));
  assert(!tools.run.includes('Verify-Peer=false'));
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map(({ runner, arch }) => [runner, arch]), [
    ['ubuntu-24.04', 'x64'], ['ubuntu-24.04-arm', 'arm64'],
  ]);
  assert.equal(workflow.jobs.arch.container.image, 'archlinux:base-devel');
  assert.equal(workflow.jobs.arch.container.options, '--shm-size=1g');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.env, {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '${{ github.workspace }}',
  });
});

test('draft creation requires the maintained branch and explicit dispatch and cannot publish automatically', () => {
  assert.equal(workflow.jobs.draft.if, "${{ !cancelled() && github.repository == 'KonTy/openchamber' && github.event_name == 'workflow_dispatch' && inputs.draft_release && github.ref == 'refs/heads/work-theme-integration-baseline' && (needs.inventory.result == 'success' || inputs.verified_run_id != '') }}");
  assert.deepEqual(workflow.jobs.draft.needs, 'inventory');
  const publication = workflow.jobs.draft.steps.find((step) => step.name === 'Upload a draft without changing the public update feed').run;
  assert(publication.includes('gh release create "v$VERSION" --draft'));
  assert(publication.includes('sha256sum --check SHA256SUMS'));
  assert(publication.includes('test "$SOURCE" = "$EXPECTED_SOURCE"'));
  assert(!publication.includes('--draft=false'));
  assert(!publication.includes('--latest'));
});

test('inventory retries require a successful baseline run and an untagged draft', () => {
  const steps = workflow.jobs.draft.steps;
  const source = steps.find((step) => step.id === 'source').run;
  for (const guard of [
    'case "$REUSE_RUN_ID" in *[!0-9]*) exit 1 ;; esac',
    'test "$(jq -r .repository.full_name <<< "$RUN")" = "$GH_REPO"',
    'test "$(jq -r .path <<< "$RUN")" = .github/workflows/release-fork-linux.yml',
    'test "$(jq -r .head_branch <<< "$RUN")" = work-theme-integration-baseline',
    'test "$(jq -r .status <<< "$RUN")" = completed',
    'test "$(jq -r .conclusion <<< "$RUN")" = success',
  ]) assert(source.includes(guard));
  const download = steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with['run-id'], '${{ steps.source.outputs.run_id }}');
  const publication = steps.find((step) => step.name === 'Upload a draft without changing the public update feed').run;
  assert(publication.includes('test "$(gh release view "v$VERSION" --json isDraft --jq .isDraft)" = true'));
  assert(publication.includes('gh api "repos/$GH_REPO/git/ref/tags/v$VERSION" --silent'));
  assert(publication.includes("grep -q '(HTTP 404)'"));
  assert(!publication.includes('gh release edit'));
  assert.equal(workflow.on.workflow_dispatch.inputs.verified_run_id.default, '');
});

test('both distro installs preserve an existing CLI and run two-window native validation', () => {
  for (const job of [workflow.jobs.build, workflow.jobs.arch]) {
    const install = job.steps.find((step) => step.name?.startsWith('Install and exercise'));
    assert(install.run.includes('CLI_SHA=$(sha256sum /usr/bin/openchamber)'));
    assert(install.run.includes('test "$(sha256sum /usr/bin/openchamber)" = "$CLI_SHA"'));
    assert(install.run.includes('scripts/smoke-theme-watch.mjs'));
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
  assert(install.run.includes('scripts/smoke-theme-watch.mjs'));
  assert(install.run.includes('docker run --rm --shm-size=1g'));
  assert(install.run.includes('ELECTRON_RUN_AS_NODE=1 /opt/OpenChamber/openchamber'));
});
