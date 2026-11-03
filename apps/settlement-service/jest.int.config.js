module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '/test/int/.*\\.int-spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  setupFiles: ['<rootDir>/test/int/env.ts'],
  globalSetup: '<rootDir>/test/int/global-setup.ts',
  testTimeout: 30000,
};
