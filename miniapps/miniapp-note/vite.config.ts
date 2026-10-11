// Build ra SCRIPT CỔ ĐIỂN (IIFE) `dist/app.js` + `dist/app.css` — KHÔNG module ES: shell nạp HTML bằng source={{html, baseUrl}} với
// allowFileAccessFromFileURLs=false nên <script type="module"> từ file:// bị chặn. scripts/package.mjs hoàn tất
// thư mục dist/ (index.html, manifest, migrations, icon, tokens.css) — đó là thư mục `registry publish` / mock SDK nhận.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    target: 'es2019',
    outDir: 'dist',
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    cssCodeSplit: false,
    lib: { entry: 'src/main.tsx', formats: ['iife'], name: 'MinaNote', fileName: () => 'app.js', cssFileName: 'app' },
  },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
