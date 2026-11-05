import 'reflect-metadata';
import Redis from 'ioredis';
import { parseArgs } from 'util';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { User } from '../auth/entities/user.entity';
import { intEnv } from '../common/env';

const ROLE_CHANGE_MEMORY_MS = 60 * 60 * 1000;

export function roleChangedKey(userId: string): string {
  return `auth:role-changed:${userId}`;
}

export async function setAdmin(
  dataSource: DataSource,
  email: string,
  admin: boolean,
  redis?: Redis,
): Promise<boolean> {
  const users = dataSource.getRepository(User);
  const user = await users.findOneBy({ email: email.trim().toLowerCase() });
  if (!user) return false;
  await redis?.set(roleChangedKey(user.id), String(Date.now()), 'PX', ROLE_CHANGE_MEMORY_MS);
  await users.update({ id: user.id }, { role: admin ? 'admin' : 'user' });
  return true;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: { revoke: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const [email] = positionals;
  if (!email) {
    process.stderr.write('Usage: node dist/tools/grant-admin.js [--revoke] <email>\n');
    return 2;
  }
  const dataSource = await new DataSource(buildDataSourceOptions()).initialize();
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: intEnv('REDIS_PORT', 6379),
    maxRetriesPerRequest: 1,
  });
  try {
    if (!(await setAdmin(dataSource, email, !values.revoke, redis))) {
      process.stderr.write(`No account is registered with ${email}\n`);
      return 1;
    }
    process.stdout.write(
      values.revoke
        ? `${email} is now a regular user, its admin access ends right away\n`
        : `${email} is now an admin, from its next sign-in or token refresh\n`,
    );
    return 0;
  } finally {
    redis.disconnect();
    await dataSource.destroy();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: Error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    },
  );
}
