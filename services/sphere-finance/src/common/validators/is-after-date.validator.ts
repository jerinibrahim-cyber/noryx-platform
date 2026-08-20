import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

/**
 * Cross-field date-order check, e.g. `endDate` after `startDate` on
 * CreateAccountingPeriodDto — a clean 400 before the request ever
 * reaches Postgres, matching the "clean 4xx instead of a raw
 * constraint/logic error" principle used throughout Finance's DTOs. Does
 * not replace `accounting_periods_end_after_start` (the real DB CHECK
 * from 2b) — this is only a better, earlier error message.
 */
@ValidatorConstraint({ name: "isAfterDate", async: false })
class IsAfterDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const [relatedPropertyName] = args.constraints as [string];
    const relatedValue = (args.object as Record<string, unknown>)[
      relatedPropertyName
    ];
    if (typeof value !== "string" || typeof relatedValue !== "string") {
      return true; // let @IsDateString on each field report the real type error
    }
    const thisDate = new Date(value);
    const relatedDate = new Date(relatedValue);
    if (
      Number.isNaN(thisDate.getTime()) ||
      Number.isNaN(relatedDate.getTime())
    ) {
      return true; // ditto — malformed dates are @IsDateString's job to report
    }
    return thisDate.getTime() > relatedDate.getTime();
  }

  defaultMessage(args: ValidationArguments): string {
    const [relatedPropertyName] = args.constraints as [string];
    return `${args.property} must be after ${relatedPropertyName}`;
  }
}

export function IsAfterDate(
  property: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [property],
      validator: IsAfterDateConstraint,
    });
  };
}
