import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('refresh_sessions')
@Index('IDX_refresh_sessions_user', ['userId'])
@Index('IDX_refresh_sessions_family', ['familyId'])
@Index('IDX_refresh_sessions_created', ['createdAt'])
export class RefreshSession {
  @PrimaryColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @Column('uuid')
  familyId: string;

  @Column('varchar')
  tokenHash: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  rotationAttempt: string | null;

  @Column({ type: 'uuid', nullable: true })
  successorId: string | null;
}
