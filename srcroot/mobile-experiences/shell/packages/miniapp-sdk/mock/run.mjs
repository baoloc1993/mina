// npm run mock -- <thư mục fixture>      vd: npm run mock -- fixtures/miniapp-hello
// Mở mock SDK (màn S10) trên trình duyệt với fixture đó làm app mở sẵn. Mở thêm một tab cho fixture khác
// (vd miniapp-hello-cal) để thử intent giữa hai app.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, '../../..');
const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
let defaultDir = null;
if (arg) {
  defaultDir = resolve(process.cwd(), arg);
  if (!existsSync(join(defaultDir, 'manifest.json'))) {
    console.error(`Không thấy manifest.json trong ${defaultDir}\nDùng: npm run mock -- fixtures/miniapp-hello`);
    process.exit(1);
  }
}
process.env.MOCK_FIXTURE_DIR = defaultDir ?? '';
process.env.MOCK_FIXTURES_ROOT = join(shellRoot, 'fixtures');

const server = await createServer({
  configFile: join(here, 'vite.config.ts'),
  server: { port: Number(process.env.MOCK_PORT) || 5199, strictPort: false, open: false },
});
await server.listen();
server.printUrls();
const name = defaultDir ? defaultDir.split(/[\\/]/).pop() : '(chọn trong trang)';
console.log(`\nMock SDK · fixture mở sẵn: ${name}\nMở thêm tab: <url>/?fixture=miniapp-hello-cal`);
