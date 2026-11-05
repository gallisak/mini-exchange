import 'reflect-metadata';
import { parseArgs } from 'util';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { User } from '../auth/entities/user.entity';

export async function setAdmin(
  dataSource: DataSource,
  email: string,
  admin: boolean,
): Promise<boolean> {
  const users = dataSource.getRepository(User);
  const wanted = email.trim();
  let user = await users.findOneBy({ email: wanted });
  if (!user) {
    const candidates = await users
      .createQueryBuilder('user')
      .where('lower(user.email) = lower(:email)', { email: wanted })
      .getMany();
    if (candidates.length > 1) {
      throw new Error(
        `${wanted} matches more than one account when case is ignored: ${candidates
          .map((candidate) => candidate.email)
          .join(', ')}. Give the email exactly as stored`,
      );
    }
    [user] = candidates;
  }
  if (!user) return false;
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
  try {
    if (!(await setAdmin(dataSource, email, !values.revoke))) {
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
