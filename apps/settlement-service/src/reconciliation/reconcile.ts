import 'reflect-metadata';
import { parseArgs } from 'util';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { EngineClient } from './engine-client';
import { ReconciliationService } from './reconciliation.service';

const EXIT_CODES = { ok: 0, mismatch: 1, incomplete: 2 } as const;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { from: { type: 'string' }, to: { type: 'string' } },
  });
  const dataSource = await new DataSource(buildDataSourceOptions()).initialize();
  try {
    const service = new ReconciliationService(dataSource, new EngineClient());
    const period = service.defaultPeriod();
    const report = await service.reconcile(
      values.from ? new Date(values.from) : period.from,
      values.to ? new Date(values.to) : period.to,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return EXIT_CODES[report.status];
  } finally {
    await dataSource.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(3);
  },
);
