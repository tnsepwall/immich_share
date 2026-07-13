import {
  AfterDeleteTrigger,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { CreateIdColumn, UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { LibraryUserRole } from 'src/enum';
import { library_user_role_enum } from 'src/schema/enums';
import { library_user_delete_audit } from 'src/schema/functions';
import { LibraryTable } from 'src/schema/tables/library.table';
import { UserTable } from 'src/schema/tables/user.table';

@Table({ name: 'library_user' })
@UpdatedAtTrigger('library_user_updatedAt')
@AfterDeleteTrigger({
  scope: 'statement',
  function: library_user_delete_audit,
  referencingOldTableAs: 'old',
  when: 'pg_trigger_depth() <= 1',
})
export class LibraryUserTable {
  @ForeignKeyColumn(() => LibraryTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
  })
  libraryId!: string;

  @ForeignKeyColumn(() => UserTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
  })
  userId!: string;

  @Column({ enum: library_user_role_enum, default: LibraryUserRole.Viewer })
  role!: Generated<LibraryUserRole>;

  // Sharee-controlled opt-in: when true, this share's library assets also surface in the recipient's
  // main Photos timeline, Explore, Map, and search (Phase 5), on top of the always-available dedicated
  // browse route. Mirrors partner.table.ts's inTimeline exactly. Per-share row; never touched by the
  // owner.
  @Column({ type: 'boolean', default: false })
  inTimeline!: Generated<boolean>;

  // Phase 6: backfill-keying watermark for the mobile pseudo-partner projection. Set to a fresh
  // immich_uuid_v7() every time inTimeline transitions false->true, cleared to NULL on true->false
  // (LibraryService.updateMyShare, in the same update as inTimeline). Deliberately NOT createId:
  // createId is the row's own creation time, but a share can be created long before the sharee ever
  // flags it for their timeline, and the mobile sync backfill loop needs a watermark keyed to the
  // flag-enable moment so a late opt-in still triggers a backfill (sync.repository.ts's
  // PartnerSync.getCreatedAfter is the model this mirrors).
  @Column({ type: 'uuid', nullable: true })
  timelineEnabledId!: string | null;

  @CreateIdColumn({ index: true })
  createId!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
