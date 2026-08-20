import { IsDateString, IsString, MaxLength, MinLength } from "class-validator";
import { IsAfterDate } from "../../common/validators/is-after-date.validator";

export class CreateAccountingPeriodDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  @IsAfterDate("startDate", { message: "endDate must be after startDate" })
  endDate!: string;
}
