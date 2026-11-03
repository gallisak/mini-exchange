import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('outbox')
@Index('IDX_outbox_unpublished', ['id'], { where: '"publishedAt" IS NULL' })
export class OutboxMessage {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column()
  stream: string;

  @Column()
  type: string;

  @Column('jsonb')
  payload: Record<string, string | number>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column('timestamptz', { nullable: true })
  publishedAt: Date | null;
}
