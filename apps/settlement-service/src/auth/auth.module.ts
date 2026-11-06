import { Global, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';
import { AdminDirectory } from './admin-directory.service';
import { SessionRevocations } from './session-revocations.service';

@Global()
@Module({
  imports: [PassportModule],
  providers: [JwtStrategy, AdminDirectory, SessionRevocations],
  exports: [AdminDirectory],
})
export class AuthModule {}
