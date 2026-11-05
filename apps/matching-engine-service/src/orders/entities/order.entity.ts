import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'open' | 'partially_filled' | 'filled' | 'cancelled';

@Entity('orders')
@Index('IDX_orders_owner_created', ['ownerId', 'createdAt'])
@Index('IDX_orders_owner_status', ['ownerId', 'status'])
@Index('IDX_orders_open_by_instrument', ['instrument', 'seq'], {
  where: `"status" IN ('open', 'partially_filled')`,
})
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  ownerId: string;

  @Column()
  instrument: string;

  @Column()
  side: OrderSide;

  @Column('numeric', { precision: 18, scale: 2 })
  price: string;

  @Column('numeric', { precision: 18, scale: 8 })
  quantity: string;

  @Column('numeric', { precision: 18, scale: 8 })
  remainingQuantity: string;

  @Column({ default: 'open' })
  status: OrderStatus;

  @Column({ type: 'timestamptz' })
  createdAt: Date;

  @Column('bigint', { nullable: true })
  seq?: string | null;
}
