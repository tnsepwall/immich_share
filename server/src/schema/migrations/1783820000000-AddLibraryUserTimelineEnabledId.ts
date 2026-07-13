import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "library_user" ADD "timelineEnabledId" uuid;`.execute(db);
  // Backfill: any share already flagged inTimeline=true before this migration must get a watermark
  // now, so the Phase 6 mobile pseudo-partner backfill loop treats it as "already enabled" rather than
  // missing a backfill entirely (see library-user.table.ts's column comment for the full rationale).
  await sql`UPDATE "library_user" SET "timelineEnabledId" = immich_uuid_v7() WHERE "inTimeline";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "library_user" DROP COLUMN "timelineEnabledId";`.execute(db);
}
