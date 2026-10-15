import { AuthSession } from 'src/database.js';
import { AuthDto } from 'src/dtos/auth.dto.js';

const authUser = {
  admin: {
    id: 'admin_id',
    name: 'admin',
    email: 'admin@test.com',
    isAdmin: true,
    quotaSizeInBytes: null,
    quotaUsageInBytes: 0,
  },
  user1: {
    id: 'user-id',
    name: 'User 1',
    email: 'immich@test.com',
    isAdmin: false,
    quotaSizeInBytes: null,
    quotaUsageInBytes: 0,
  },
};

export const authStub = {
  admin: Object.freeze<AuthDto>({ user: authUser.admin }),
  user1: Object.freeze<AuthDto>({
    user: authUser.user1,
    session: {
      id: 'token-id',
    } as AuthSession,
  }),
  // fork (shared libraries specs): a second, non-admin user - upstream dropped it, the library specs still need one
  user2: Object.freeze<AuthDto>({
    user: {
      id: 'user-2',
      name: 'User 2',
      email: 'user2@immich.cloud',
      isAdmin: false,
      quotaSizeInBytes: null,
      quotaUsageInBytes: 0,
    },
    session: {
      id: 'token-id',
    } as AuthSession,
  }),
  adminWithElevatedPermission: Object.freeze<AuthDto>({
    user: authUser.admin,
    session: {
      id: 'token-id-elevated',
      hasElevatedPermission: true,
    } as AuthSession,
  }),
  adminSharedLink: Object.freeze({
    user: authUser.admin,
    sharedLink: {
      id: '123',
      showExif: true,
      allowDownload: true,
      allowUpload: true,
      albumId: null,
      expiresAt: null,
      password: null,
      userId: '42',
    },
  }),
};
