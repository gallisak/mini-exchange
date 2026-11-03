import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '../auth/jwt.strategy';
import { LedgerService } from '../ledger/ledger.service';

@Controller('wallets')
@UseGuards(JwtAuthGuard)
export class WalletsController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('me')
  async me(@Req() request: Request) {
    const { userId } = request.user as AuthUser;
    return { ownerId: userId, balances: await this.ledger.wallet(userId) };
  }
}
