import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { intEnv } from '../common/env';

@Injectable()
export class AdminDirectory {
  private readonly timeoutMs = intEnv('ADMIN_CHECK_TIMEOUT_MS', 10_000);

  async isAdmin(userId: string): Promise<boolean> {
    const url = new URL(
      `/auth/admins/${encodeURIComponent(userId)}`,
      process.env.ENGINE_URL ?? 'http://localhost:3001',
    );
    let body: { admin?: unknown } | null;
    try {
      const response = await fetch(url, {
        headers: { 'x-internal-key': process.env.ENGINE_INTERNAL_KEY ?? '' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      body = response.ok ? ((await response.json()) as { admin?: unknown }) : null;
    } catch {
      body = null;
    }
    if (typeof body?.admin !== 'boolean') {
      throw new ServiceUnavailableException('Cannot check the admin role right now, try again shortly');
    }
    return body.admin;
  }
}
