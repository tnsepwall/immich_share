import { Kysely, sql } from 'kysely';

// Hand-written: no live Postgres instance was available to run `pnpm --filter immich run migrations:generate`
// in the environment this migration was authored in. See 1783648584743-AddSharedLibraryAccess.ts (Phase 1) for
// the same caveat. Re-generate and diff against this file when a dev DB is available.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album_asset" ADD "sourceLibraryId" uuid;`.execute(db);
  await sql`ALTER TABLE "album_asset" ADD CONSTRAINT "album_asset_sourceLibraryId_fkey" FOREIGN KEY ("sourceLibraryId") REFERENCES "library" ("id") ON UPDATE CASCADE ON DELETE CASCADE;`.execute(
    db,
  );
  await sql`CREATE INDEX "album_asset_sourceLibraryId_idx" ON "album_asset" ("sourceLibraryId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "album_asset_sourceLibraryId_idx";`.execute(db);
  await sql`ALTER TABLE "album_asset" DROP CONSTRAINT "album_asset_sourceLibraryId_fkey";`.execute(db);
  await sql`ALTER TABLE "album_asset" DROP COLUMN "sourceLibraryId";`.execute(db);
}
