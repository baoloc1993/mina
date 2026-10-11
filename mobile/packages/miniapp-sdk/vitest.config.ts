import { defineConfig } from 'vitest/config';

// Vitest của gói SDK (npm run test:sdk ở thư mục shell). Mặc định môi trường node; test cần DOM khai
// `// @vitest-environment happy-dom` ở đầu file.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});
