import { Kysely, sql } from 'kysely';

// Hand-written: no live Postgres instance was available to run `pnpm --filter immich run migrations:generate`
// in the environment this migration was authored in. Structure mirrors 1781089983296-CreateIntegrityReportTable.ts
// and 1747664684909-AddAlbumAuditTables.ts. Re-generate and diff against this file when a dev DB is available.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TYPE "library_user_role_enum" AS ENUM ('viewer','editor');`.execute(db);

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

  await sql`CREATE TABLE "library_user" (
  "libraryId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "role" "library_user_role_enum" NOT NULL DEFAULT 'viewer'::library_user_role_enum,
  "createId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "library_user_pkey" PRIMARY KEY ("libraryId", "userId"),
  CONSTRAINT "library_user_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "library" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "library_user_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);`.execute(db);
  await sql`CREATE INDEX "library_user_createId_idx" ON "library_user" ("createId");`.execute(db);
  await sql`CREATE INDEX "library_user_updateId_idx" ON "library_user" ("updateId");`.execute(db);

  await sql`CREATE TABLE "library_user_audit" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "libraryId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "deletedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "library_user_audit_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "library_user_audit_libraryId_idx" ON "library_user_audit" ("libraryId");`.execute(db);
  await sql`CREATE INDEX "library_user_audit_userId_idx" ON "library_user_audit" ("userId");`.execute(db);
  await sql`CREATE INDEX "library_user_audit_deletedAt_idx" ON "library_user_audit" ("deletedAt");`.execute(db);

  await sql`CREATE OR REPLACE TRIGGER "library_user_updatedAt"
  BEFORE UPDATE ON "library_user"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);

  await sql`CREATE OR REPLACE TRIGGER "library_user_delete_audit"
  AFTER DELETE ON "library_user"
  REFERENCING OLD TABLE AS "old"
  FOR EACH STATEMENT
  WHEN (pg_trigger_depth() <= 1)
  EXECUTE FUNCTION library_user_delete_audit();`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER "library_user_delete_audit" ON "library_user";`.execute(db);
  await sql`DROP TRIGGER "library_user_updatedAt" ON "library_user";`.execute(db);
  await sql`DROP TABLE "library_user_audit";`.execute(db);
  await sql`DROP TABLE "library_user";`.execute(db);
  await sql`DROP FUNCTION library_user_delete_audit;`.execute(db);
  await sql`DROP TYPE "library_user_role_enum";`.execute(db);
}
