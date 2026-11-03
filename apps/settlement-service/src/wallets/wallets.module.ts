import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletsController } from './wallets.controller';

@Module({
  imports: [LedgerModule],
  controllers: [WalletsController],
})
export class WalletsModule {}
