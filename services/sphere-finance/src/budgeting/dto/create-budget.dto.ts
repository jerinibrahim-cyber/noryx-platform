import { IsDateString, IsString, MaxLength, MinLength } from "class-validator";
import { IsAfterDate } from "../../common/validators/is-after-date.validator";

/// currencyCode is deliberately NOT a field here — always server-resolved
/// from the legal entity's functional currency (legalEntities.currencyCode)
/// at create time, never client input. Same convention as every other
/// Finance create path (SupplierBillsService.resolveCurrency), applied
/// directly rather than disclosed as a later deviation (contract §5/§6).
export class CreateBudgetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  @IsAfterDate("startDate", { message: "endDate must be after startDate" })
  endDate!: string;
}
