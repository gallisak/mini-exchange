import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { WalletNotifier } from '../notifications/wallet-notifier.service';

@Module({
  providers: [LedgerService, WalletNotifier],
  exports: [LedgerService],
})
export class LedgerModule {}
