import { DataSource } from 'typeorm';
import { User } from '../src/auth/entities/user.entity';
import { Order } from '../src/orders/entities/order.entity';

describe('entity metadata', () => {
  it('builds Postgres metadata for every entity', async () => {
    const dataSource = new DataSource({ type: 'postgres', entities: [User, Order] });
    const builder = dataSource as unknown as { buildMetadatas(): Promise<void> };

    await expect(builder.buildMetadatas()).resolves.toBeUndefined();
    expect(dataSource.getMetadata(User).findColumnWithPropertyName('refreshTokenHash')?.type).toBe(
      'varchar',
    );
  });
});
