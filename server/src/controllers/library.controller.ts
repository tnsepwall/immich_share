import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { AssetResponseDto } from 'src/dtos/asset-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  LibraryAssetBulkUpdateDto,
  LibraryAssetBulkUpdateParams,
  LibraryAssetUpdateDto,
  LibraryAssetUpdateParams,
} from 'src/dtos/library-editor.dto';
import {
  LibraryFaceAssignDto,
  LibraryFaceResponseDto,
  LibraryManualFaceDto,
  LibraryPeopleResponseDto,
  LibraryPeopleSearchDto,
  LibraryPersonCreateDto,
  LibraryPersonIdParams,
  LibraryPersonParams,
  LibraryPersonResponseDto,
  LibraryPersonUpdateDto,
} from 'src/dtos/library-person.dto';
import {
  CreateLibraryDto,
  LibraryResponseDto,
  LibraryStatsResponseDto,
  LibraryUserResponseDto,
  LibraryUsersDto,
  LibraryUserUpdateDto,
  SharedLibraryResponseDto,
  UpdateLibraryDto,
  ValidateLibraryDto,
  ValidateLibraryResponseDto,
} from 'src/dtos/library.dto';
import { ApiTag, Permission } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { LibraryEditorService } from 'src/services/library-editor.service';
import { LibraryService } from 'src/services/library.service';
import { ParseMeUUIDPipe, UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.Libraries)
@Controller('libraries')
export class LibraryController {
  constructor(
    private service: LibraryService,
    private editorService: LibraryEditorService,
  ) {}

  @Get()
  @Authenticated({ permission: Permission.LibraryRead, admin: true })
  @Endpoint({
    summary: 'Retrieve libraries',
    description: 'Retrieve a list of external libraries.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAllLibraries(): Promise<LibraryResponseDto[]> {
    return this.service.getAll();
  }

  @Post()
  @Authenticated({ permission: Permission.LibraryCreate, admin: true })
  @Endpoint({
    summary: 'Create a library',
    description: 'Create a new external library.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  createLibrary(@Body() dto: CreateLibraryDto): Promise<LibraryResponseDto> {
    return this.service.create(dto);
  }

  @Get('mine')
  @Authenticated({ permission: Permission.LibraryRead })
  @Endpoint({
    summary: 'Retrieve my libraries',
    description: 'Retrieve the external libraries owned by the current user, including their shared users.',
    history: new HistoryBuilder().added('v3'),
  })
  getMyLibraries(@Auth() auth: AuthDto): Promise<LibraryResponseDto[]> {
    return this.service.getMine(auth);
  }

  @Get('shared-with-me')
  @Authenticated({ permission: Permission.LibraryRead })
  @Endpoint({
    summary: 'Retrieve libraries shared with me',
    description: 'Retrieve the external libraries other users have shared with the current user.',
    history: new HistoryBuilder().added('v3'),
  })
  getLibrariesSharedWithMe(@Auth() auth: AuthDto): Promise<SharedLibraryResponseDto[]> {
    return this.service.getSharedWithMe(auth);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.LibraryRead, admin: true })
  @Endpoint({
    summary: 'Retrieve a library',
    description: 'Retrieve an external library by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getLibrary(@Param() { id }: UUIDParamDto): Promise<LibraryResponseDto> {
    return this.service.get(id);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.LibraryUpdate, admin: true })
  @Endpoint({
    summary: 'Update a library',
    description: 'Update an existing external library.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateLibrary' }),
  })
  updateLibrary(@Param() { id }: UUIDParamDto, @Body() dto: UpdateLibraryDto): Promise<LibraryResponseDto> {
    return this.service.update(id, dto);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.LibraryUpdate, admin: true })
  updateLibraryV3(@Param() { id }: UUIDParamDto, @Body() dto: UpdateLibraryDto): Promise<LibraryResponseDto> {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.LibraryDelete, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a library',
    description: 'Delete an external library by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deleteLibrary(@Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(id);
  }

  @Post(':id/validate')
  @Authenticated({ admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Validate library settings',
    description: 'Validate the settings of an external library.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  // TODO: change endpoint to validate current settings instead
  validate(@Param() { id }: UUIDParamDto, @Body() dto: ValidateLibraryDto): Promise<ValidateLibraryResponseDto> {
    return this.service.validate(id, dto);
  }

  @Get(':id/statistics')
  @Authenticated({ permission: Permission.LibraryStatistics, admin: true })
  @Endpoint({
    summary: 'Retrieve library statistics',
    description:
      'Retrieve statistics for a specific external library, including number of videos, images, and storage usage.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getLibraryStatistics(@Param() { id }: UUIDParamDto): Promise<LibraryStatsResponseDto> {
    return this.service.getStatistics(id);
  }

  @Post(':id/scan')
  @Authenticated({ permission: Permission.LibraryUpdate, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Scan a library',
    description: 'Queue a scan for the external library to find and import new assets.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  scanLibrary(@Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.queueScan(id);
  }

  @Put(':id/users')
  @Authenticated({ permission: Permission.LibraryShare })
  @Endpoint({
    summary: 'Share a library',
    description: 'Add users to an external library as a Viewer or Editor. Owner (or admin) only.',
    history: new HistoryBuilder().added('v3'),
  })
  addLibraryUsers(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: LibraryUsersDto,
  ): Promise<LibraryUserResponseDto[]> {
    return this.service.addUsers(auth, id, dto);
  }

  @Put(':id/users/:userId')
  @Authenticated({ permission: Permission.LibraryShare })
  @Endpoint({
    summary: "Update a library user's role",
    description: 'Change a shared user between Viewer and Editor. Owner (or admin) only.',
    history: new HistoryBuilder().added('v3'),
  })
  updateLibraryUser(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Param('userId', new ParseMeUUIDPipe({ version: '4' })) userId: string,
    @Body() dto: LibraryUserUpdateDto,
  ): Promise<LibraryUserResponseDto> {
    return this.service.updateUserRole(auth, id, userId, dto);
  }

  @Delete(':id/users/:userId')
  @Authenticated({ permission: Permission.LibraryShare })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Remove a library user',
    description: 'Remove a shared user from the library. Use an ID of "me" to leave a shared library.',
    history: new HistoryBuilder().added('v3'),
  })
  removeLibraryUser(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Param('userId', new ParseMeUUIDPipe({ version: '4' })) userId: string,
  ): Promise<void> {
    return this.service.removeUser(auth, id, userId);
  }

  @Patch(':libraryId/assets/:assetId')
  @Authenticated({ permission: Permission.LibraryAssetUpdate })
  @Endpoint({
    summary: 'Update a library asset',
    description:
      'Update the allowlisted metadata (description, date/time, time zone, location, rating) of an asset in an external library. Requires the library owner or the Editor role on the library share.',
    history: new HistoryBuilder().added('v3'),
  })
  updateLibraryAsset(
    @Auth() auth: AuthDto,
    @Param() { libraryId, assetId }: LibraryAssetUpdateParams,
    @Body() dto: LibraryAssetUpdateDto,
  ): Promise<AssetResponseDto> {
    return this.editorService.updateAsset(auth, libraryId, assetId, dto);
  }

  @Patch(':libraryId/assets')
  @Authenticated({ permission: Permission.LibraryAssetUpdate })
  @Endpoint({
    summary: 'Update library assets',
    description:
      'Update the allowlisted metadata (description, date/time, time zone, location, rating) of multiple assets in an external library atomically. Requires the library owner or the Editor role on the library share.',
    history: new HistoryBuilder().added('v3'),
  })
  updateLibraryAssets(
    @Auth() auth: AuthDto,
    @Param() { libraryId }: LibraryAssetBulkUpdateParams,
    @Body() dto: LibraryAssetBulkUpdateDto,
  ): Promise<AssetResponseDto[]> {
    return this.editorService.updateAssets(auth, libraryId, dto);
  }

  @Get(':libraryId/people')
  @Authenticated({ permission: Permission.LibraryPersonRead })
  @Endpoint({
    summary: 'Retrieve library people',
    description:
      'Retrieve the people reachable through this library. Requires the library owner or the Editor/Viewer role on the library share.',
    history: new HistoryBuilder().added('v3'),
  })
  getLibraryPeople(
    @Auth() auth: AuthDto,
    @Param() { libraryId }: LibraryPersonParams,
    @Query() dto: LibraryPeopleSearchDto,
  ): Promise<LibraryPeopleResponseDto> {
    return this.editorService.getPeople(auth, libraryId, dto);
  }

  @Post(':libraryId/people')
  @Authenticated({ permission: Permission.LibraryPersonCreate })
  @Endpoint({
    summary: 'Create a library person',
    description:
      'Create a new person owned by the library owner from a set of faces within this library, and assign the faces to it. Requires the library owner or the Editor role on the library share.',
    history: new HistoryBuilder().added('v3'),
  })
  createLibraryPerson(
    @Auth() auth: AuthDto,
    @Param() { libraryId }: LibraryPersonParams,
    @Body() dto: LibraryPersonCreateDto,
  ): Promise<LibraryPersonResponseDto> {
    return this.editorService.createPerson(auth, libraryId, dto);
  }

  @Put(':libraryId/people/:personId')
  @Authenticated({ permission: Permission.LibraryPersonUpdate })
  @Endpoint({
    summary: 'Rename a library person',
    description:
      'Rename a person reachable through this library. Only allowed when every one of the faces of this person is within this library. Requires the library owner or the Editor role on the library share.',
    history: new HistoryBuilder().added('v3'),
  })
  updateLibraryPerson(
    @Auth() auth: AuthDto,
    @Param() { libraryId, personId }: LibraryPersonIdParams,
    @Body() dto: LibraryPersonUpdateDto,
  ): Promise<LibraryPersonResponseDto> {
    return this.editorService.updatePersonName(auth, libraryId, personId, dto);
  }

  @Get(':libraryId/assets/:assetId/faces')
  @Authenticated({ permission: Permission.LibraryPersonRead })
  @Endpoint({
    summary: 'Retrieve library asset faces',
    description:
      'Retrieve the faces detected on an asset in this library. Requires the library owner or the Editor/Viewer role on the library share.',
    history: new HistoryBuilder().added('v3'),
  })
  getLibraryAssetFaces(
    @Auth() auth: AuthDto,
    @Param() { libraryId, assetId }: LibraryAssetUpdateParams,
  ): Promise<LibraryFaceResponseDto[]> {
    return this.editorService.getAssetFaces(auth, libraryId, assetId);
  }

  @Post(':libraryId/faces')
  @Authenticated({ permission: Permission.LibraryFaceCreate })
  @Endpoint({
    summary: 'Create a manual library face',
    description:
      'Draw a new face bounding box on an asset in this library and assign it to a person reachable through this library. Requires the library owner or the Editor role on the library share.',
    history: new HistoryBuilder().added('v3'),
  })
  createLibraryFace(
    @Auth() auth: AuthDto,
    @Param() { libraryId }: LibraryPersonParams,
    @Body() dto: LibraryManualFaceDto,
  ): Promise<LibraryFaceResponseDto> {
    return this.editorService.createManualFace(auth, libraryId, dto);
  }

  @Put(':libraryId/faces')
  @Authenticated({ permission: Permission.LibraryFaceUpdate })
  @Endpoint({
    summary: 'Assign library faces',
    description:
      'Reassign a set of faces within this library to a person reachable through this library. Requires the library owner or the Editor role on the library share.',
    history: new HistoryBuilder().added('v3'),
  })
  assignLibraryFaces(
    @Auth() auth: AuthDto,
    @Param() { libraryId }: LibraryPersonParams,
    @Body() dto: LibraryFaceAssignDto,
  ): Promise<LibraryFaceResponseDto[]> {
    return this.editorService.assignFaces(auth, libraryId, dto);
  }
}
