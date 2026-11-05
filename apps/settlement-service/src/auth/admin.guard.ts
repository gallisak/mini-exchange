import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthUser } from './jwt.strategy';
import { RoleChanges } from './role-changes.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly roles: RoleChanges) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (user?.role !== 'admin' || (await this.roles.changedSince(user.userId, user.issuedAt))) {
      throw new ForbiddenException('Admin role required');
    }
    return true;
  }
}
