import { DataSource } from 'typeorm';
import { RefreshSession } from '../src/auth/entities/refresh-session.entity';
import { entities } from '../src/database/data-source';

describe('entity metadata', () => {
  it('builds Postgres metadata for every entity', async () => {
    const dataSource = new DataSource({ type: 'postgres', entities });
    const builder = dataSource as unknown as { buildMetadatas(): Promise<void> };

    await expect(builder.buildMetadatas()).resolves.toBeUndefined();
    expect(dataSource.getMetadata(RefreshSession).findColumnWithPropertyName('tokenHash')?.type).toBe(
      'varchar',
    );
  });
});
