# Linux Updater E2E Fixture

This local-only harness verifies AppImage N-to-N+1 replacement without changing the
production GitHub updater provider. It supports native x64 and arm64 hosts.

1. Build N on the native target architecture. Set the test-build marker only
   while bundling main, then complete normal packaging:

   ```bash
   OPENCHAMBER_TARGET_ARCH=x64 OPENCHAMBER_UPDATER_E2E_BUILD=1 bun run bundle:main
   OPENCHAMBER_TARGET_ARCH=x64 node ./scripts/package.mjs --linux --x64 --publish=never
   ```

   Use `OPENCHAMBER_TARGET_ARCH=arm64` and `--arm64` on an arm64 host. N+1 can be a
   normal production AppImage. Build it separately only when it needs unpublished
   changes, and keep the 2 AppImages in separate output directories.

2. Copy N into a separate writable run directory. Set `HOME`, the XDG directories,
   `OPENCHAMBER_DATA_DIR`, `OPENCHAMBER_DESKTOP_USER_DATA_DIR` and
   `OPENCODE_CONFIG_DIR` to fresh fixture directories before launching.
   The fixture command inherits these values and does not isolate a profile itself.
   Launch the copy of N against a loopback fixture containing N+1:

   ```bash
   bun run updater:e2e:fixture -- run \
     --arch x64 \
     --current /absolute/path/OpenChamber-N-linux-x86_64.AppImage \
     --next /absolute/path/OpenChamber-N+1-linux-x86_64.AppImage \
     --version N+1 \
     --dir /tmp/openchamber-updater-e2e
   ```

3. In N, check for updates, download/install, and restart. Verify the restarted app
   reports N+1 and that the file at `APPIMAGE` was replaced. Repeat with `--arch arm64`
   and the arm64 AppImages on the arm64 host.

The harness binds only `127.0.0.1`. Runtime override activation additionally requires
`OPENCHAMBER_E2E=1`, the loopback URL set by the harness, and the build-time marker.
Normal packages omit the build-time marker and use this fork's
`KonTy/openchamber` feed.
The renderer, IPC bridge, command-line arguments, and persistent configuration do not
have access to the feed URL.
