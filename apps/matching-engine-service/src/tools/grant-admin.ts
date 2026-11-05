import 'reflect-metadata';
import { parseArgs } from 'util';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { User } from '../auth/entities/user.entity';

export async function setAdmin(dataSource: DataSource, email: string, admin: boolean): Promise<boolean> {
  const result = await dataSource
    .getRepository(User)
    .update({ email: email.trim().toLowerCase() }, { role: admin ? 'admin' : 'user' });
  return (result.affected ?? 0) > 0;
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
  try {
    if (!(await setAdmin(dataSource, email, !values.revoke))) {
      process.stderr.write(`No account is registered with ${email}\n`);
      return 1;
    }
    process.stdout.write(
      `${email} is now ${values.revoke ? 'a regular user' : 'an admin'}, from its next sign-in or token refresh\n`,
    );
    return 0;
  } finally {
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
