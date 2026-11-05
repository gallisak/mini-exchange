import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('outbox')
@Index('IDX_outbox_unpublished', ['id'], { where: '"publishedAt" IS NULL' })
@Index('IDX_outbox_published_at', ['publishedAt'], { where: '"publishedAt" IS NOT NULL' })
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
