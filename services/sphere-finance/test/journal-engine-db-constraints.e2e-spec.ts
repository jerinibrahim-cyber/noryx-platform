import { randomUUID } from "node:crypto";
import postgres from "postgres";

/**
 * 2b is schema/DB-layer only (docs/finance-journal-engine-proposal.md
 * §12) — there is no service/API yet, so these tests exercise the
 * database directly with a raw `postgres` client, the same way
 * apply-db-constraints.ts and the backfill script do. That is the point:
 * every guarantee here must hold even for a write that never went through
 * AccountsService/JournalEntriesService at all — proving the database
 * itself enforces these invariants, not merely that application code
 * happens to.
 *
 * No RLS session variable is set anywhere in this file (mirroring
 * apply-db-constraints.ts / backfill-legal-entity-id.ts), so
 * tenant_isolation's `current_setting(...) IS NULL` branch applies and
 * every statement can see/write across tenants — deliberately, since this
 * file is testing accounting invariants, not tenant isolation (that's
 * accounts.e2e-spec.ts's job, at the API layer where RLS is actually
 * exercised through the real request path).
 */
describe("Journal Engine — DB-level accounting invariants (2b, schema layer only)", () => {
  let sql: postgres.Sql;
  let tenantId: string;
  let legalEntityId: string;
  let assetAccountId: string;
  let revenueAccountId: string;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 5 });

    const [tenant] = await sql`
      INSERT INTO tenants (slug, name)
      VALUES (${"je-db-" + Date.now()}, 'Journal Engine DB Test Tenant')
      RETURNING id
    `;
    tenantId = tenant!.id as string;

    const [entity] = await sql`
      INSERT INTO legal_entities (tenant_id, name, code, country_code, currency_code, is_default)
      VALUES (${tenantId}, 'JE DB Test Entity', 'JEDB', 'AE', 'AED', true)
      RETURNING id
    `;
    legalEntityId = entity!.id as string;

    const [assetAccount] = await sql`
      INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type)
      VALUES (${tenantId}, ${legalEntityId}, 'ASSET-1', 'Cash', 'ASSET')
      RETURNING id
    `;
    assetAccountId = assetAccount!.id as string;

    const [revenueAccount] = await sql`
      INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type)
      VALUES (${tenantId}, ${legalEntityId}, 'REV-1', 'Sales', 'REVENUE')
      RETURNING id
    `;
    revenueAccountId = revenueAccount!.id as string;
  });

  afterAll(async () => {
    await sql.end();
  });

  /** Inserts a DRAFT journal_entries row with no journal_number, returns its id. */
  async function createDraftEntry(
    transactionDate = "2026-08-15",
  ): Promise<string> {
    const [entry] = await sql`
      INSERT INTO journal_entries (tenant_id, legal_entity_id, status, transaction_date, currency_code)
      VALUES (${tenantId}, ${legalEntityId}, 'DRAFT', ${transactionDate}, 'AED')
      RETURNING id
    `;
    return entry!.id as string;
  }

  async function insertLine(
    journalEntryId: string,
    lineNumber: number,
    accountId: string,
    debitMinor: number,
    creditMinor: number,
  ): Promise<void> {
    await sql`
      INSERT INTO journal_lines (tenant_id, journal_entry_id, line_number, account_id, debit_minor, credit_minor)
      VALUES (${tenantId}, ${journalEntryId}, ${lineNumber}, ${accountId}, ${debitMinor}, ${creditMinor})
    `;
  }

  describe("accounting period overlap — EXCLUDE constraint", () => {
    it("allows a non-overlapping period", async () => {
      await sql`
        INSERT INTO accounting_periods (tenant_id, legal_entity_id, code, start_date, end_date)
        VALUES (${tenantId}, ${legalEntityId}, 'OVERLAP-2026-08', '2026-08-01', '2026-08-31')
      `;
    });

    it("rejects a period whose range overlaps an existing one for the same tenant+entity", async () => {
      await expect(
        sql`
          INSERT INTO accounting_periods (tenant_id, legal_entity_id, code, start_date, end_date)
          VALUES (${tenantId}, ${legalEntityId}, 'OVERLAP-2026-08B', '2026-08-15', '2026-09-15')
        `,
      ).rejects.toThrow(/conflicting key value violates exclusion constraint/);
    });

    it("allows the same overlapping date range for a DIFFERENT tenant — the exclusion is scoped, not global", async () => {
      const [otherTenant] = await sql`
        INSERT INTO tenants (slug, name) VALUES (${"je-db-other-" + Date.now()}, 'Other Tenant') RETURNING id
      `;
      const [otherEntity] = await sql`
        INSERT INTO legal_entities (tenant_id, name, code, country_code, currency_code, is_default)
        VALUES (${otherTenant!.id}, 'Other Entity', 'OTH', 'AE', 'AED', true) RETURNING id
      `;
      await sql`
        INSERT INTO accounting_periods (tenant_id, legal_entity_id, code, start_date, end_date)
        VALUES (${otherTenant!.id}, ${otherEntity!.id}, 'OVERLAP-2026-08', '2026-08-01', '2026-08-31')
      `;
    });

    it("rejects end_date <= start_date via the CHECK constraint", async () => {
      await expect(
        sql`
          INSERT INTO accounting_periods (tenant_id, legal_entity_id, code, start_date, end_date)
          VALUES (${tenantId}, ${legalEntityId}, 'BACKWARDS', '2026-09-01', '2026-08-01')
        `,
      ).rejects.toThrow(/accounting_periods_end_after_start/);
    });
  });

  describe("journal number allocation — race-free counter", () => {
    it("allocates N concurrent increments as distinct, gap-free sequential numbers", async () => {
      const N = 10;
      const results = await Promise.all(
        Array.from(
          { length: N },
          () =>
            sql`
            INSERT INTO journal_number_counters (tenant_id, legal_entity_id, last_assigned_number)
            VALUES (${tenantId}, ${legalEntityId}, 1)
            ON CONFLICT (tenant_id, legal_entity_id)
            DO UPDATE SET last_assigned_number = journal_number_counters.last_assigned_number + 1
            RETURNING last_assigned_number
          `,
        ),
      );
      const numbers = results
        .map((r) => r[0]!.last_assigned_number as number)
        .sort((a, b) => a - b);
      const unique = new Set(numbers);
      expect(unique.size).toBe(N); // no duplicates under concurrency
      expect(numbers).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // gap-free 1..N
    });
  });

  describe("journal_number uniqueness — DB-level backstop independent of the counter", () => {
    it("allows unlimited DRAFT entries with a null journal_number", async () => {
      await createDraftEntry();
      await createDraftEntry();
      // no error — NULL is distinct from NULL under a standard UNIQUE constraint
    });

    it("rejects two entries with the same non-null journal_number in the same tenant+entity", async () => {
      const entry1 = await createDraftEntry();
      await sql`UPDATE journal_entries SET journal_number = 'JE-DUPTEST' WHERE id = ${entry1}`;

      const entry2 = await createDraftEntry();
      await expect(
        sql`UPDATE journal_entries SET journal_number = 'JE-DUPTEST' WHERE id = ${entry2}`,
      ).rejects.toThrow(/journal_entries_tenant_entity_number_unique/);
    });
  });

  describe("balance invariant — deferred constraint trigger", () => {
    it("allows posting a balanced entry", async () => {
      const entryId = await createDraftEntry();
      await insertLine(entryId, 1, assetAccountId, 10000, 0);
      await insertLine(entryId, 2, revenueAccountId, 0, 10000);
      await sql`
        UPDATE journal_entries
        SET status = 'POSTED', posted_at = now(), journal_number = ${"JE-BAL-" + randomUUID().slice(0, 8)}
        WHERE id = ${entryId}
      `;
      const [row] =
        await sql`SELECT status FROM journal_entries WHERE id = ${entryId}`;
      expect(row!.status).toBe("POSTED");
    });

    it("rejects posting an unbalanced entry — even though the two writes are separate statements, the deferred trigger catches it at commit", async () => {
      await expect(
        sql.begin(async (tx) => {
          const [entry] = await tx`
            INSERT INTO journal_entries (tenant_id, legal_entity_id, status, transaction_date, currency_code)
            VALUES (${tenantId}, ${legalEntityId}, 'DRAFT', '2026-08-15', 'AED')
            RETURNING id
          `;
          const entryId = entry!.id as string;
          // Lines inserted while DRAFT — allowed, even though unbalanced,
          // because balance is only enforced for POSTED entries.
          await tx`
            INSERT INTO journal_lines (tenant_id, journal_entry_id, line_number, account_id, debit_minor, credit_minor)
            VALUES (${tenantId}, ${entryId}, 1, ${assetAccountId}, 10000, 0)
          `;
          await tx`
            INSERT INTO journal_lines (tenant_id, journal_entry_id, line_number, account_id, debit_minor, credit_minor)
            VALUES (${tenantId}, ${entryId}, 2, ${revenueAccountId}, 0, 5000)
          `;
          // Only NOW, in the same transaction, does the entry get flipped
          // to POSTED — this UPDATE never touches journal_lines at all,
          // which is exactly the gap a trigger attached only to
          // journal_lines would miss. The companion trigger on
          // journal_entries itself is what catches this.
          await tx`
            UPDATE journal_entries SET status = 'POSTED', posted_at = now() WHERE id = ${entryId}
          `;
        }),
      ).rejects.toThrow(/unbalanced/);
    });

    it("rejects posting an entry with fewer than 2 lines", async () => {
      await expect(
        sql.begin(async (tx) => {
          const [entry] = await tx`
            INSERT INTO journal_entries (tenant_id, legal_entity_id, status, transaction_date, currency_code)
            VALUES (${tenantId}, ${legalEntityId}, 'DRAFT', '2026-08-15', 'AED')
            RETURNING id
          `;
          const entryId = entry!.id as string;
          await tx`
            INSERT INTO journal_lines (tenant_id, journal_entry_id, line_number, account_id, debit_minor, credit_minor)
            VALUES (${tenantId}, ${entryId}, 1, ${assetAccountId}, 10000, 0)
          `;
          await tx`UPDATE journal_entries SET status = 'POSTED', posted_at = now() WHERE id = ${entryId}`;
        }),
      ).rejects.toThrow(/fewer than 2 lines/);
    });

    it("DRAFT entries are never checked for balance, however unbalanced", async () => {
      const entryId = await createDraftEntry();
      await insertLine(entryId, 1, assetAccountId, 10000, 0);
      await insertLine(entryId, 2, revenueAccountId, 0, 1);
      const [row] =
        await sql`SELECT status FROM journal_entries WHERE id = ${entryId}`;
      expect(row!.status).toBe("DRAFT"); // never rejected — no error was thrown above
    });
  });

  describe("journal_lines immutability — no exceptions once parent is POSTED", () => {
    let postedEntryId: string;
    let postedLineId: string;

    beforeAll(async () => {
      postedEntryId = await createDraftEntry();
      await insertLine(postedEntryId, 1, assetAccountId, 20000, 0);
      const [line2] = await sql`
        INSERT INTO journal_lines (tenant_id, journal_entry_id, line_number, account_id, debit_minor, credit_minor)
        VALUES (${tenantId}, ${postedEntryId}, 2, ${revenueAccountId}, 0, 20000)
        RETURNING id
      `;
      postedLineId = line2!.id as string;
      await sql`
        UPDATE journal_entries
        SET status = 'POSTED', posted_at = now(), journal_number = ${"JE-IMMUT-" + randomUUID().slice(0, 8)}
        WHERE id = ${postedEntryId}
      `;
    });

    it("rejects UPDATE of a line belonging to a POSTED entry", async () => {
      await expect(
        sql`UPDATE journal_lines SET debit_minor = 99999 WHERE id = ${postedLineId}`,
      ).rejects.toThrow(/immutable once its parent journal_entries is POSTED/);
    });

    it("rejects DELETE of a line belonging to a POSTED entry", async () => {
      await expect(
        sql`DELETE FROM journal_lines WHERE id = ${postedLineId}`,
      ).rejects.toThrow(/immutable once its parent journal_entries is POSTED/);
    });

    it("rejects INSERT of a new line into an already-POSTED entry", async () => {
      await expect(
        sql`
          INSERT INTO journal_lines (tenant_id, journal_entry_id, line_number, account_id, debit_minor, credit_minor)
          VALUES (${tenantId}, ${postedEntryId}, 3, ${assetAccountId}, 500, 0)
        `,
      ).rejects.toThrow(/immutable once its parent journal_entries is POSTED/);
    });

    it("DRAFT entries' lines remain freely editable", async () => {
      const draftId = await createDraftEntry();
      await insertLine(draftId, 1, assetAccountId, 100, 0);
      const [line] = await sql`
        SELECT id FROM journal_lines WHERE journal_entry_id = ${draftId} LIMIT 1
      `;
      await sql`UPDATE journal_lines SET debit_minor = 200 WHERE id = ${line!.id}`;
      await sql`DELETE FROM journal_lines WHERE id = ${line!.id}`;
      // no error — proves the immutability trigger doesn't over-trigger on drafts
    });
  });

  describe("journal_entries immutability — narrowly validated reversal-link exception", () => {
    let postedEntryId: string;
    let reversalEntryId: string;

    beforeAll(async () => {
      postedEntryId = await createDraftEntry();
      await insertLine(postedEntryId, 1, assetAccountId, 15000, 0);
      await insertLine(postedEntryId, 2, revenueAccountId, 0, 15000);
      await sql`
        UPDATE journal_entries
        SET status = 'POSTED', posted_at = now(), journal_number = ${"JE-REV-ORIG-" + randomUUID().slice(0, 8)}
        WHERE id = ${postedEntryId}
      `;

      reversalEntryId = await createDraftEntry();
      await insertLine(reversalEntryId, 1, assetAccountId, 0, 15000);
      await insertLine(reversalEntryId, 2, revenueAccountId, 15000, 0);
      await sql`
        UPDATE journal_entries
        SET status = 'POSTED', posted_at = now(), journal_number = ${"JE-REV-NEW-" + randomUUID().slice(0, 8)}
        WHERE id = ${reversalEntryId}
      `;
    });

    it("rejects DELETE of a POSTED entry", async () => {
      await expect(
        sql`DELETE FROM journal_entries WHERE id = ${postedEntryId}`,
      ).rejects.toThrow(/immutable once POSTED: DELETE is not permitted/);
    });

    it("rejects changing an ordinary field (memo) on a POSTED entry", async () => {
      await expect(
        sql`UPDATE journal_entries SET memo = 'tampered' WHERE id = ${postedEntryId}`,
      ).rejects.toThrow(/immutable once POSTED/);
    });

    it("rejects changing status back to DRAFT on a POSTED entry", async () => {
      await expect(
        sql`UPDATE journal_entries SET status = 'DRAFT' WHERE id = ${postedEntryId}`,
      ).rejects.toThrow(/immutable once POSTED/);
    });

    it("allows setting reversed_by_journal_entry_id, and only that column, exactly once", async () => {
      await sql`
        UPDATE journal_entries SET reversed_by_journal_entry_id = ${reversalEntryId} WHERE id = ${postedEntryId}
      `;
      const [row] = await sql`
        SELECT reversed_by_journal_entry_id FROM journal_entries WHERE id = ${postedEntryId}
      `;
      expect(row!.reversed_by_journal_entry_id).toBe(reversalEntryId);
    });

    it("rejects setting reversed_by_journal_entry_id a second time — a journal can only be reversed once", async () => {
      const anotherEntryId = await createDraftEntry();
      await insertLine(anotherEntryId, 1, assetAccountId, 4000, 0);
      await insertLine(anotherEntryId, 2, revenueAccountId, 0, 4000);
      await sql`
        UPDATE journal_entries
        SET status = 'POSTED', posted_at = now(), journal_number = ${"JE-2ND-" + randomUUID().slice(0, 8)}
        WHERE id = ${anotherEntryId}
      `;

      await expect(
        sql`
          UPDATE journal_entries SET reversed_by_journal_entry_id = ${anotherEntryId} WHERE id = ${postedEntryId}
        `,
      ).rejects.toThrow(/already reversed/);
    });

    it("rejects setting reversed_by_journal_entry_id together with any other field change — the exception is narrow, not a green light for the whole row", async () => {
      const freshOriginal = await createDraftEntry();
      await insertLine(freshOriginal, 1, assetAccountId, 5000, 0);
      await insertLine(freshOriginal, 2, revenueAccountId, 0, 5000);
      await sql`
        UPDATE journal_entries
        SET status = 'POSTED', posted_at = now(), journal_number = ${"JE-NARROW-" + randomUUID().slice(0, 8)}
        WHERE id = ${freshOriginal}
      `;

      await expect(
        sql`
          UPDATE journal_entries
          SET reversed_by_journal_entry_id = ${reversalEntryId}, memo = 'sneaking this in too'
          WHERE id = ${freshOriginal}
        `,
      ).rejects.toThrow(/immutable once POSTED/);
    });

    it("rejects an updated_at-only mutation on a POSTED entry — no column is exempted from immutability, not even the timestamp", async () => {
      // A fresh, not-yet-reversed entry: postedEntryId was already reversed
      // by an earlier test in this block, which would trip the "already
      // reversed" guard first rather than exercising the column check this
      // test targets.
      const freshEntryId = await createDraftEntry();
      await insertLine(freshEntryId, 1, assetAccountId, 3000, 0);
      await insertLine(freshEntryId, 2, revenueAccountId, 0, 3000);
      await sql`
        UPDATE journal_entries
        SET status = 'POSTED', posted_at = now(), journal_number = ${"JE-UPDT-" + randomUUID().slice(0, 8)}
        WHERE id = ${freshEntryId}
      `;

      await expect(
        sql`UPDATE journal_entries SET updated_at = now() WHERE id = ${freshEntryId}`,
      ).rejects.toThrow(/immutable once POSTED/);
    });
  });

  describe("journal_lines line-number uniqueness — UNIQUE(journal_entry_id, line_number)", () => {
    it("rejects a duplicate line_number within the same journal entry", async () => {
      const entryId = await createDraftEntry();
      await insertLine(entryId, 1, assetAccountId, 1000, 0);
      await expect(
        insertLine(entryId, 1, revenueAccountId, 0, 1000),
      ).rejects.toThrow(/journal_lines_entry_line_number_unique/);
    });

    it("allows the same line_number across two different journal entries", async () => {
      const entryA = await createDraftEntry();
      const entryB = await createDraftEntry();
      await insertLine(entryA, 1, assetAccountId, 1000, 0);
      // no error — the uniqueness is scoped per journal_entry_id, not global
      await insertLine(entryB, 1, assetAccountId, 2000, 0);
    });
  });

  describe("journal_lines nonzero — CHECK(debit_minor > 0 OR credit_minor > 0)", () => {
    it("rejects a line with both debit and credit at zero", async () => {
      const entryId = await createDraftEntry();
      await expect(
        insertLine(entryId, 1, assetAccountId, 0, 0),
      ).rejects.toThrow(/journal_lines_nonzero/);
    });

    it("accepts a debit-only line", async () => {
      const entryId = await createDraftEntry();
      await insertLine(entryId, 1, assetAccountId, 500, 0);
    });

    it("accepts a credit-only line", async () => {
      const entryId = await createDraftEntry();
      await insertLine(entryId, 1, revenueAccountId, 0, 500);
    });

    it("rejects a line with both debit and credit positive (single-sided rule, not the new nonzero rule)", async () => {
      const entryId = await createDraftEntry();
      await expect(
        insertLine(entryId, 1, assetAccountId, 500, 500),
      ).rejects.toThrow(/journal_lines_single_sided/);
    });

    it("rejects a line with a negative amount", async () => {
      const entryId = await createDraftEntry();
      await expect(
        insertLine(entryId, 1, assetAccountId, -500, 0),
      ).rejects.toThrow(/journal_lines_amounts_non_negative/);
    });
  });
});
