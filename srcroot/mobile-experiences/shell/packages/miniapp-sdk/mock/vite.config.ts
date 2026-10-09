import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { mockPlugin } from './plugin';

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, '../../..');

export default defineConfig({
  root: here,
  plugins: [
    mockPlugin({
      fixturesRoot: process.env.MOCK_FIXTURES_ROOT || join(shellRoot, 'fixtures'),
      defaultDir: process.env.MOCK_FIXTURE_DIR || null,
      configDir: process.env.MOCK_CONFIG_DIR || join(shellRoot, '../../../deployment/local/seed/configs'),
    }),
  ],
  // Mock chạy chính mã bridge của shell (shell/src/bridge) — cho phép đọc ra ngoài root.
  server: { fs: { allow: [shellRoot] } },
  // SQLite WASM tự nạp .wasm bằng import.meta.url — không để Vite tiền đóng gói.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  build: { outDir: join(here, 'dist'), emptyOutDir: true, target: 'es2022' },
});
