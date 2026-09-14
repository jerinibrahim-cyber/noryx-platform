CREATE TYPE "public"."cash_flow_category" AS ENUM('OPERATING', 'INVESTING', 'FINANCING');--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD COLUMN "cash_flow_category" "cash_flow_category";