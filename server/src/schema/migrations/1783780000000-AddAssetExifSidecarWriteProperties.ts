import { Kysely, sql } from 'kysely';

// Hand-written: no live Postgres instance was available to run `pnpm --filter immich run migrations:generate`
// in the environment this migration was authored in. See 1783648584743-AddSharedLibraryAccess.ts (Phase 1) and
// 1783693635932-AddAlbumAssetSourceLibrary.ts (Phase 2) for the same caveat. Re-generate and diff against this
// file when a dev DB is available.
//
// sidecarWriteProperties splits off from the existing lockedProperties column: lockedProperties now means
// "protected from metadata-extraction overwrite", while sidecarWriteProperties means "still pending an XMP
// sidecar write". Existing rows backfill sidecarWriteProperties = lockedProperties so already-queued owner
// writes are not lost on upgrade (see FEATURE-PLAN-shared-external-libraries.md Step 1/2).
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_exif" ADD "sidecarWriteProperties" character varying[];`.execute(db);
  await sql`UPDATE "asset_exif" SET "sidecarWriteProperties" = "lockedProperties" WHERE "lockedProperties" IS NOT NULL;`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_exif" DROP COLUMN "sidecarWriteProperties";`.execute(db);
}
