import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User } from '../entities/user.entity';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<{ user?: { userId?: string; role?: string } }>().user;
    const stored =
      user?.role === 'admin' && user.userId
        ? await this.dataSource.getRepository(User).findOne({
            select: { id: true, role: true },
            where: { id: user.userId },
          })
        : null;
    if (stored?.role !== 'admin') throw new ForbiddenException('Admin role required');
    return true;
  }
}
