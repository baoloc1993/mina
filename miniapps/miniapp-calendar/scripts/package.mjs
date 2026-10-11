// Hoàn tất dist/ sau `vite build`: index.html (script cổ điển), manifest.json, migrations/, icon.png, tokens.css.
// dist/ là thư mục để `registry publish dist` (CLI zip tái lập) hoặc `npm run mock -- <dist>` nhận.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const tokens = join(root, '../../mobile/packages/miniapp-sdk/tokens/tokens.css');
if (!existsSync(join(dist, 'app.js'))) throw new Error('chưa có dist/app.js — chạy `vite build` trước');

// Mock SDK nhúng app.js vào <script> trong HTML: chuỗi "</script" trong bundle sẽ cắt cụt thẻ. `<\/script` là cùng giá trị trong JS.
const js = readFileSync(join(dist, 'app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
writeFileSync(join(dist, 'app.js'), js);

cpSync(join(root, 'public'), dist, { recursive: true });
cpSync(tokens, join(dist, 'tokens.css')); // bản sao token chung — mini app không tự định nghĩa màu (DESIGN-SYSTEM.md)

const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.json'), 'utf8'));
mkdirSync(dist, { recursive: true });
writeFileSync(
  join(dist, 'index.html'),
  `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${manifest.name}</title>
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="app.css">
</head>
<body>
<div id="root"></div>
<script src="app.js"></script>
</body>
</html>
`,
);
console.log(`dist/ sẵn sàng: ${manifest.id} ${manifest.version} (app.js ${Math.round(js.length / 1024)} KB)`);
