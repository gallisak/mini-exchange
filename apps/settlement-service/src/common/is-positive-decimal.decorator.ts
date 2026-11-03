import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';
import { isPositiveDecimal } from './decimal';

export function IsPositiveDecimal(
  integerDigits: number,
  scale: number,
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isPositiveDecimal',
      constraints: [integerDigits, scale],
      validator: {
        validate: (value: unknown) => isPositiveDecimal(value, integerDigits, scale),
        defaultMessage: buildMessage(
          (each) =>
            `${each}$property must be a positive decimal string with at most ${integerDigits} integer digits and ${scale} decimal places`,
          options,
        ),
      },
    },
    options,
  );
}
