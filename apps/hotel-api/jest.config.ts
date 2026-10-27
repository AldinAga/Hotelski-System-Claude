import type { Config } from 'jest';

// One regex covers unit specs (src/*.spec.ts) and e2e specs (test/*.e2e-spec.ts);
// testMatch globs misbehave on Windows with relative roots.
const config: Config = {
  rootDir: '.',
  testRegex: '(src|test)/.*(\\.spec|\\.e2e-spec)\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  testEnvironment: 'node',
  // DB specs will share one Postgres database; parallel workers would truncate
  // each other's rows.
  maxWorkers: 1,
};

export default config;
