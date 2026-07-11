import { Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto';
import { MapMarkerDto, MapMarkerResponseDto, MapReverseGeocodeDto } from 'src/dtos/map.dto';
import { BaseService } from 'src/services/base.service';
import { getMyPartnerIds } from 'src/utils/asset.util';

@Injectable()
export class MapService extends BaseService {
  async getMapMarkers(auth: AuthDto, options: MapMarkerDto): Promise<MapMarkerResponseDto[]> {
    const userIds = [auth.user.id];
    if (options.withPartners) {
      const partnerIds = await getMyPartnerIds({ userId: auth.user.id, repository: this.partnerRepository });
      userIds.push(...partnerIds);
    }

    const albumIds = options.withSharedAlbums ? await this.albumRepository.getAllIds(auth.user.id) : [];

    // Phase 5 (§4): deliberate deviation from the partner map semantics above - a partner's
    // `inTimeline` flag is ignored on the map (whoever is in `userIds` is included), but a shared
    // library's markers are gated by the SAME per-share `inTimeline` flag that governs the main
    // timeline. A client-side toggle (`withSharedLibraries`) double-gates it on top.
    //
    // Review finding fix: drop the shared-library arm entirely when the caller filters on isFavorite -
    // the repository ANDs that filter across all arms, so withSharedLibraries+isFavorite would
    // enumerate exactly which shared assets the OWNER favorited. Same probe class the timeline rejects
    // and search's dropSharedLibraryProbe() defends against.
    const libraryIds =
      options.withSharedLibraries && options.isFavorite === undefined
        ? await this.libraryRepository.getInTimelineSharedLibraryIds(auth.user.id)
        : [];

    return this.mapRepository.getMapMarkers(auth.user.id, userIds, albumIds, libraryIds, options);
  }

  async reverseGeocode(dto: MapReverseGeocodeDto) {
    const { lat: latitude, lon: longitude } = dto;
    // eventually this should probably return an array of results
    const result = await this.mapRepository.reverseGeocode({ latitude, longitude });
    return result ? [result] : [];
  }
}
