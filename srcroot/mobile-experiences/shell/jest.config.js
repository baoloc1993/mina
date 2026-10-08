module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\.(t|j)sx?$': ['ts-jest', { tsconfig: { allowJs: true, esModuleInterop: true, module: 'commonjs', target: 'es2022', strict: true, types: ['jest', 'node'] }, diagnostics: false }] },
  transformIgnorePatterns: ['/node_modules/(?!@noble)'],
};
