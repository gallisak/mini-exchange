import { BadRequestException, ExecutionContext, createParamDecorator } from '@nestjs/common';

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const value: unknown = context.switchToHttp().getRequest().headers['idempotency-key'];
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new BadRequestException(
      'Idempotency-Key header is required: 1 to 100 letters, digits, "-" or "_"',
    );
  }
  return value;
});
