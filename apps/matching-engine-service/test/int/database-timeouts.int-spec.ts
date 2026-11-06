import { AddressInfo, Server, Socket, connect, createServer } from 'net';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source';

interface FreezableDatabase {
  port: number;
  freeze(): void;
  thaw(): void;
  close(): Promise<void>;
}

async function freezableDatabase(): Promise<FreezableDatabase> {
  let frozen = false;
  const held: (() => void)[] = [];
  const sockets = new Set<Socket>();
  const upstream = { port: Number(process.env.DATABASE_PORT), host: process.env.DATABASE_HOST };
  const server: Server = createServer((client) => {
    const database = connect(upstream.port, upstream.host);
    sockets.add(client).add(database);
    client.pipe(database);
    database.on('data', (chunk) => {
      if (frozen) held.push(() => client.write(chunk));
      else client.write(chunk);
    });
    const close = () => {
      client.destroy();
      database.destroy();
    };
    client.on('close', close).on('error', close);
    database.on('close', close).on('error', close);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    freeze: () => {
      frozen = true;
    },
    thaw: () => {
      frozen = false;
      held.splice(0).forEach((write) => write());
    },
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('a database that stops answering', () => {
  const saved = { ...process.env };
  let first: DataSource;
  let second: DataSource;

  beforeEach(async () => {
    Object.assign(process.env, { DATABASE_STATEMENT_TIMEOUT_MS: '500', DATABASE_LOCK_TIMEOUT_MS: '300' });
    first = await new DataSource(buildDataSourceOptions()).initialize();
    second = await new DataSource(buildDataSourceOptions()).initialize();
  });

  afterEach(async () => {
    process.env = { ...saved };
    await first.destroy();
    await second.destroy();
  });

  it('gives up on a query that runs too long instead of waiting forever', async () => {
    const started = Date.now();

    await expect(first.query('SELECT pg_sleep(5)')).rejects.toThrow(/statement timeout/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('gives up waiting for a lock someone else holds', async () => {
    const holder = first.createQueryRunner();
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock(424242)');
    try {
      await expect(second.query('SELECT pg_advisory_lock(424242)')).rejects.toThrow(/lock timeout/);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(424242)');
      await holder.release();
    }
  });

  describe('behind a connection that goes silent', () => {
    let database: FreezableDatabase;
    let silent: DataSource;

    beforeEach(async () => {
      database = await freezableDatabase();
      Object.assign(process.env, { DATABASE_HOST: '127.0.0.1', DATABASE_PORT: String(database.port) });
      silent = await new DataSource(buildDataSourceOptions()).initialize();
    });

    afterEach(async () => {
      database.thaw();
      await silent.destroy();
      await database.close();
    });

    it('gives up on a query Postgres never answers and drops that connection', async () => {
      database.freeze();
      const started = Date.now();

      await expect(silent.query('SELECT 1')).rejects.toThrow(/Query read timeout/);
      const waited = Date.now() - started;
      database.thaw();

      expect(waited).toBeGreaterThanOrEqual(5_000);
      expect(waited).toBeLessThan(8_000);
      await expect(silent.query('SELECT 1 AS "one"')).resolves.toEqual([{ one: 1 }]);
    });

    it('waits for a COMMIT however long it takes, since giving up on it would leave its outcome unknown', async () => {
      const runner = silent.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      await runner.query('SELECT 1');
      database.freeze();

      let committed = false;
      const commit = runner.commitTransaction().then(() => {
        committed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 6_500));
      expect(committed).toBe(false);
      database.thaw();

      await commit;
      expect(committed).toBe(true);
      await runner.release();
    });
  });
});
