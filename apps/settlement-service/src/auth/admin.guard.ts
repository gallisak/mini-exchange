import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthUser } from './jwt.strategy';
import { AdminDirectory } from './admin-directory.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly directory: AdminDirectory) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (user?.role !== 'admin' || !(await this.directory.isAdmin(user.userId))) {
      throw new ForbiddenException('Admin role required');
    }
    return true;
  }
}
