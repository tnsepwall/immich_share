import type { AssetStackResponseDto, AssetVisibility } from '@immich/sdk';
import type { TimelineDate, TimelineDateTime, TimelineYearMonth } from '$lib/utils/timeline-util';

export type ViewportTopMonth = TimelineYearMonth | undefined | 'lead-in' | 'lead-out';

export type AssetApiGetTimeBucketsRequest = Parameters<typeof import('@immich/sdk').getTimeBuckets>[0];

export type TimelineManagerOptions = Omit<AssetApiGetTimeBucketsRequest, 'size'> & {
  timelineAlbumId?: string;
  deferInit?: boolean;
  assetFilter?: Set<string>;
  /**
   * Filter assets to a specific shared external library (see the `/shared-libraries/[libraryId]`
   * route). TEMPORARY: not yet a known field on `AssetApiGetTimeBucketsRequest` because
   * `packages/sdk` hasn't been regenerated for this feature (see web/src/lib/api/library-share.ts)
   * - the server's TimeBucketDto already accepts it. Like `timelineAlbumId`/`deferInit`/
   * `assetFilter` above, this rides along on the options object but is not itself a field the
   * generated `getTimeBuckets`/`getTimeBucket` functions know about; the two call sites that build
   * the actual network request (timeline-manager.svelte.ts, internal/load-support.svelte.ts)
   * intersect the request type there so it's still sent to the server.
   */
  libraryId?: string;
};

export type AssetDescriptor = { id: string };

export type Direction = 'earlier' | 'later';

export type TimelineAsset = {
  id: string;
  ownerId: string;
  tags?: string[];
  ratio: number;
  thumbhash: string | null;
  localDateTime: TimelineDateTime;
  createdAt: TimelineDateTime;
  fileCreatedAt: TimelineDateTime;
  visibility: AssetVisibility;
  isFavorite: boolean;
  isTrashed: boolean;
  isVideo: boolean;
  isImage: boolean;
  stack: AssetStackResponseDto | null;
  duration: number | null;
  projectionType: string | null;
  livePhotoVideoId: string | null;
  city: string | null;
  country: string | null;
  people: string[] | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type MoveAsset = { asset: TimelineAsset; date: TimelineDate };

export interface Viewport {
  width: number;
  height: number;
}

export type ViewportXY = Viewport & {
  x: number;
  y: number;
};

export interface AddAsset {
  type: 'add';
  values: TimelineAsset[];
}

export interface UpdateAsset {
  type: 'update';
  values: TimelineAsset[];
}

export interface DeleteAsset {
  type: 'delete';
  values: string[];
}

export interface TrashAssets {
  type: 'trash';
  values: string[];
}

export type PendingChange = AddAsset | UpdateAsset | DeleteAsset | TrashAssets;

export type ScrubberMonth = {
  height: number;
  assetCount: number;
  year: number;
  month: number;
  title: string;
};

export type TimelineManagerLayoutOptions = {
  rowHeight?: number;
  headerHeight?: number;
  gap?: number;
};

export interface UpdateGeometryOptions {
  invalidateHeight: boolean;
  noDefer?: boolean;
}
