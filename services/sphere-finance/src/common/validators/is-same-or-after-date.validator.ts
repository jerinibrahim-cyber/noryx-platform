import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

/**
 * Cross-field date-order check for a ledger/balance date **range**
 * (`dateTo >= dateFrom`), used by 2d's query DTOs —
 * docs/finance-2d-general-ledger-read-layer-proposal.md §14's "note on
 * the new validator". Deliberately NOT `IsAfterDate` (2c-1, strict `>`,
 * correct for `startDate`/`endDate` on an accounting period, where a
 * zero-length period is meaningless): a ledger/balance range of
 * `dateFrom === dateTo` is a completely valid single-day query, so this
 * sibling validator uses `>=` instead of reusing/parameterizing
 * `IsAfterDate`, to avoid changing that validator's existing,
 * already-reviewed behavior for accounting periods.
 */
@ValidatorConstraint({ name: "isSameOrAfterDate", async: false })
class IsSameOrAfterDateConstraint implements ValidatorConstraintInterface {
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
    return thisDate.getTime() >= relatedDate.getTime();
  }

  defaultMessage(args: ValidationArguments): string {
    const [relatedPropertyName] = args.constraints as [string];
    return `${args.property} must be the same date as, or after, ${relatedPropertyName}`;
  }
}

export function IsSameOrAfterDate(
  property: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [property],
      validator: IsSameOrAfterDateConstraint,
    });
  };
}
