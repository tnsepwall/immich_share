import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_face" ADD "timestampMs" integer;`.execute(db);
  await sql`ALTER TABLE "asset_job_status" ADD "videoFacesRecognizedAt" timestamp with time zone;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_job_status" DROP COLUMN "videoFacesRecognizedAt";`.execute(db);
  await sql`ALTER TABLE "asset_face" DROP COLUMN "timestampMs";`.execute(db);
}
