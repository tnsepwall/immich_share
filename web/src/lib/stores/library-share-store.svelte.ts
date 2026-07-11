import { getLibrariesSharedWithMe, type LibraryUserRole } from '@immich/sdk';
import { SvelteMap } from 'svelte/reactivity';
import { authManager } from '$lib/managers/auth-manager.svelte';

/**
 * Phase 5 (§6.3): session cache of the current user's shared-library roles, keyed by library id -
 * loaded once, on demand, from `GET /libraries/shared-with-me`. Used to derive a
 * `LibraryShareContext` for an asset encountered OUTSIDE the dedicated `/shared-libraries/:id`
 * route (the main timeline, once a shared-library asset's `inTimeline` flag surfaces it there),
 * so Phase 4's role-aware DetailPanel/LibraryAssetEditorPanel/LibraryFacePanel light up
 * identically everywhere a shared-library asset can appear - not just on the dedicated browse
 * route, which keeps building its own explicit context from its own `+page.ts` loader.
 *
 * Best-effort: the cache is empty until `ensureLoaded()` resolves, so the very first shared asset
 * viewed in a session may briefly show no library-aware affordances until the cache warms up -
 * reactivity then re-derives `libraryShare` for whatever asset is open once it does. The dedicated
 * route is unaffected either way since it never reads from this store.
 */
class LibraryShareStore {
  #rolesByLibraryId = $state<SvelteMap<string, LibraryUserRole>>(new SvelteMap());
  #loaded = false;
  #loading: Promise<void> | undefined;

  async #load(): Promise<void> {
    if (!authManager.authenticated) {
      return;
    }

    const shares = await getLibrariesSharedWithMe();
    const roles = new SvelteMap<string, LibraryUserRole>();
    for (const share of shares) {
      roles.set(share.id, share.role);
    }
    this.#rolesByLibraryId = roles;
    this.#loaded = true;
  }

  /** Idempotent - safe to call from every mount site that might need the cache; only fetches once. */
  async ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    this.#loading ??= this.#load().finally(() => {
      this.#loading = undefined;
    });
    await this.#loading;
  }

  /** Reactive lookup - `undefined` until the cache is loaded, or when not shared with this user at all. */
  getRole(libraryId: string): LibraryUserRole | undefined {
    return this.#rolesByLibraryId.get(libraryId);
  }

  /** Call after any action that can change the caller's own share list or role (leave, role change by the owner, new share accepted) so the next `ensureLoaded()` refetches. */
  invalidate() {
    this.#loaded = false;
    this.#rolesByLibraryId = new SvelteMap();
  }
}

export const libraryShareStore = new LibraryShareStore();
