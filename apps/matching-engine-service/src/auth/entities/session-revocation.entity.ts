import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('session_revocations')
@Index('IDX_session_revocations_unannounced', ['revokedAt'], { where: '"announcedAt" IS NULL' })
@Index('IDX_session_revocations_revoked_at', ['revokedAt'])
export class SessionRevocation {
  @PrimaryColumn('uuid')
  familyId: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  revokedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  announcedAt: Date | null;
}
