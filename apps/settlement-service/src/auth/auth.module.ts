import { Global, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';
import { AdminDirectory } from './admin-directory.service';

@Global()
@Module({
  imports: [PassportModule],
  providers: [JwtStrategy, AdminDirectory],
  exports: [AdminDirectory],
})
export class AuthModule {}
