import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

export function MaxBytes(limit: number, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'maxBytes',
      constraints: [limit],
      validator: {
        validate: (value: unknown) => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= limit,
        defaultMessage: buildMessage(
          (each) => `${each}$property must be at most ${limit} bytes long`,
          options,
        ),
      },
    },
    options,
  );
}
