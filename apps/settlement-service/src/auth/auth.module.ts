import { Global, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';
import { RoleChanges } from './role-changes.service';

@Global()
@Module({
  imports: [PassportModule],
  providers: [JwtStrategy, RoleChanges],
  exports: [RoleChanges],
})
export class AuthModule {}
