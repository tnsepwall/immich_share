import { Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { checkAccess } from 'src/utils/access.js';
import { newAccessRepositoryMock } from 'test/repositories/access.repository.mock.js';
import { factory } from 'test/small.factory.js';

describe('checkAccess', () => {
  describe(Permission.LibraryAssetUpdate, () => {
    it('should union library owner and Editor access', async () => {
      const accessMock = newAccessRepositoryMock();
      const auth = factory.auth();
      const ownedLibraryId = factory.uuid();
      const editorLibraryId = factory.uuid();
      const viewerLibraryId = factory.uuid();

      accessMock.library.checkOwnerAccess.mockResolvedValue(new Set([ownedLibraryId]));
      accessMock.library.checkEditorAccess.mockResolvedValue(new Set([editorLibraryId]));

      const result = await checkAccess(accessMock as unknown as AccessRepository, {
        auth,
        permission: Permission.LibraryAssetUpdate,
        ids: [ownedLibraryId, editorLibraryId, viewerLibraryId],
      });

      expect(result).toEqual(new Set([ownedLibraryId, editorLibraryId]));
      expect(accessMock.library.checkOwnerAccess).toHaveBeenCalledWith(
        auth.user.id,
        new Set([ownedLibraryId, editorLibraryId, viewerLibraryId]),
      );
      expect(accessMock.library.checkEditorAccess).toHaveBeenCalledWith(
        auth.user.id,
        new Set([editorLibraryId, viewerLibraryId]),
      );
    });

    it('should not consult the role-agnostic shared access check (Viewer must not pass)', async () => {
      const accessMock = newAccessRepositoryMock();
      const auth = factory.auth();
      const viewerLibraryId = factory.uuid();

      // a Viewer share would satisfy checkSharedAccess but not checkEditorAccess
      accessMock.library.checkSharedAccess.mockResolvedValue(new Set([viewerLibraryId]));

      const result = await checkAccess(accessMock as unknown as AccessRepository, {
        auth,
        permission: Permission.LibraryAssetUpdate,
        ids: [viewerLibraryId],
      });

      expect(result).toEqual(new Set());
      expect(accessMock.library.checkSharedAccess).not.toHaveBeenCalled();
    });

    it('should deny everything for a shared link', async () => {
      const accessMock = newAccessRepositoryMock();
      const auth = factory.auth({ sharedLink: {} });
      const libraryId = factory.uuid();

      accessMock.library.checkOwnerAccess.mockResolvedValue(new Set([libraryId]));
      accessMock.library.checkEditorAccess.mockResolvedValue(new Set([libraryId]));

      const result = await checkAccess(accessMock as unknown as AccessRepository, {
        auth,
        permission: Permission.LibraryAssetUpdate,
        ids: [libraryId],
      });

      expect(result).toEqual(new Set());
      expect(accessMock.library.checkOwnerAccess).not.toHaveBeenCalled();
      expect(accessMock.library.checkEditorAccess).not.toHaveBeenCalled();
    });
  });
});
