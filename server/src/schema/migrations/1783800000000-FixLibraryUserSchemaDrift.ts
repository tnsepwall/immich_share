import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION library_user_delete_audit()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      INSERT INTO library_user_audit ("libraryId", "userId")
      SELECT "libraryId", "userId"
      FROM OLD;
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE INDEX "library_user_libraryId_idx" ON "library_user" ("libraryId");`.execute(db);
  await sql`CREATE INDEX "library_user_userId_idx" ON "library_user" ("userId");`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_library_user_delete_audit', '{"type":"function","name":"library_user_delete_audit","sql":"CREATE OR REPLACE FUNCTION library_user_delete_audit()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      INSERT INTO library_user_audit (\\"libraryId\\", \\"userId\\")\\n      SELECT \\"libraryId\\", \\"userId\\"\\n      FROM OLD;\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_library_user_delete_audit', '{"type":"trigger","name":"library_user_delete_audit","sql":"CREATE OR REPLACE TRIGGER \\"library_user_delete_audit\\"\\n  AFTER DELETE ON \\"library_user\\"\\n  REFERENCING OLD TABLE AS \\"old\\"\\n  FOR EACH STATEMENT\\n  WHEN (pg_trigger_depth() <= 1)\\n  EXECUTE FUNCTION library_user_delete_audit();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_library_user_updatedAt', '{"type":"trigger","name":"library_user_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"library_user_updatedAt\\"\\n  BEFORE UPDATE ON \\"library_user\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION public.library_user_delete_audit()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    BEGIN
      INSERT INTO library_user_audit ("libraryId", "userId")
      SELECT "libraryId", "userId"
      FROM OLD;
      RETURN NULL;
    END
  $function$
`.execute(db);
  await sql`DROP INDEX "library_user_libraryId_idx";`.execute(db);
  await sql`DROP INDEX "library_user_userId_idx";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_library_user_delete_audit';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_library_user_delete_audit';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_library_user_updatedAt';`.execute(db);
}
