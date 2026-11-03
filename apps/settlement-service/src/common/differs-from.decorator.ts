import { ValidateBy, ValidationArguments, ValidationOptions, buildMessage } from 'class-validator';

export function DiffersFrom(property: string, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'differsFrom',
      constraints: [property],
      validator: {
        validate: (value: unknown, args?: ValidationArguments) =>
          value !== (args?.object as Record<string, unknown>)[property],
        defaultMessage: buildMessage(
          (each) => `${each}$property must differ from ${property}`,
          options,
        ),
      },
    },
    options,
  );
}
