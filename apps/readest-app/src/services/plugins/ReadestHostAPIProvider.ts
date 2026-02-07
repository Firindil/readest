/**
 * @module plugins/ReadestHostAPIProvider
 * Implements the SDK's HostAPIProvider interface for Readest.
 *
 * This is the factory that creates all 7 API instances (BookAPI, AnnotationAPI,
 * UIAPI, CommandAPI, SidecarAPI, SettingsAPI, StorageAPI) using the Phase 1
 * provider implementations and the SDK's built-in API classes.
 *
 * The PluginLoader calls this provider once per plugin load to build the
 * sandboxed API object for that plugin.
 */

import type { ComponentType } from 'react';
import type {
  HostAPIProvider,
  BookAPI,
  AnnotationAPI,
  UIAPI,
  CommandAPI,
  SidecarAPI,
  SettingsAPI,
  StorageAPI,
  PluginManifest,
  Disposable,
  ToolbarButton,
  ContextMenuItem,
  StatusBarItem,
  PanelProps,
  SettingsProps,
  ModalProps,
  ProgressReporter,
} from '@readest/plugin-sdk';
import {
  BookAPIImpl,
  AnnotationAPIImpl,
  CommandAPIImpl,
  SidecarAPIImpl,
  SettingsAPIImpl,
  StorageAPIImpl,
} from '@readest/plugin-sdk';

import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { usePluginStore } from '@/store/pluginStore';
import environmentConfig from '@/services/environment';

import {
  ReadestBookDataProvider,
  type ReadestBookStoreAccessors,
} from './providers/ReadestBookDataProvider';
import {
  ReadestAnnotationDataProvider,
  type ReadestAnnotationStoreAccessors,
} from './providers/ReadestAnnotationDataProvider';
import { ReadestUIHost, type EventDispatcherLike } from './providers/ReadestUIHost';
import { createProcessSpawner } from './providers/TauriProcessSpawner';
import { createFileSystem, getPluginDataBasePath } from './providers/TauriFileSystem';

// ---------------------------------------------------------------------------
// Settings persistence via localStorage
// ---------------------------------------------------------------------------

/** Key prefix for persisting plugin settings in localStorage */
const SETTINGS_LS_PREFIX = '__readest_plugin_settings__:';

/**
 * Create a persistence callback that saves plugin settings to localStorage.
 * In a Tauri environment this could be upgraded to file-based persistence,
 * but localStorage is sufficient for the initial integration.
 *
 * @returns A SettingsPersistCallback for SettingsAPIImpl
 */
function createSettingsPersister() {
  return async (pluginId: string, settings: Record<string, unknown>): Promise<void> => {
    try {
      localStorage.setItem(
        SETTINGS_LS_PREFIX + pluginId,
        JSON.stringify(settings),
      );
    } catch (error) {
      console.error(`[Plugins] Failed to persist settings for ${pluginId}:`, error);
    }
  };
}

/**
 * Load previously persisted settings for a plugin from localStorage.
 *
 * @param pluginId - The plugin ID
 * @returns The persisted settings record, or undefined if none exist
 */
function loadPersistedSettings(pluginId: string): Record<string, unknown> | undefined {
  try {
    const raw = localStorage.getItem(SETTINGS_LS_PREFIX + pluginId);
    if (raw) {
      return JSON.parse(raw) as Record<string, unknown>;
    }
  } catch {
    // Ignore parse errors
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ReadestHostAPIProvider
// ---------------------------------------------------------------------------

/**
 * Configuration for creating a ReadestHostAPIProvider.
 */
export interface ReadestHostAPIProviderConfig {
  /** Function that returns the current active book key */
  bookKeyAccessor: () => string | null;
  /** The event dispatcher for toast notifications */
  eventDispatcher: EventDispatcherLike;
  /** Base path for plugin data storage (resolved at init time) */
  pluginDataBasePath: string;
}

/**
 * Implements the SDK's HostAPIProvider interface for Readest.
 *
 * Each `create*API()` method is called once per plugin load by the SDK's
 * `createSandboxedAPI()`. The provider reads from Readest's Zustand stores
 * and delegates UI registrations to the pluginStore.
 *
 * The bookKeyAccessor is a function rather than a value so that the provider
 * always references the latest active book, even if the user switches books
 * after the plugin was loaded.
 */
export class ReadestHostAPIProvider implements HostAPIProvider {
  private readonly _bookKeyAccessor: () => string | null;
  private readonly _uiHost: ReadestUIHost;
  private readonly _commandAPI: CommandAPIImpl;
  private readonly _processSpawner: ReturnType<typeof createProcessSpawner>;
  private readonly _fileSystem: ReturnType<typeof createFileSystem>;
  private readonly _pluginDataBasePath: string;
  private readonly _settingsPersister: (
    pluginId: string,
    settings: Record<string, unknown>,
  ) => Promise<void>;

  /**
   * Create a new ReadestHostAPIProvider.
   *
   * @param config - The configuration for this provider
   */
  constructor(config: ReadestHostAPIProviderConfig) {
    this._bookKeyAccessor = config.bookKeyAccessor;
    this._uiHost = new ReadestUIHost(config.eventDispatcher);
    this._commandAPI = new CommandAPIImpl();
    this._processSpawner = createProcessSpawner();
    this._fileSystem = createFileSystem();
    this._pluginDataBasePath = config.pluginDataBasePath;
    this._settingsPersister = createSettingsPersister();
  }

  /**
   * Get the shared ReadestUIHost instance.
   * The host UI layer can use this to register modal/confirm/progress handlers.
   */
  get uiHost(): ReadestUIHost {
    return this._uiHost;
  }

  /**
   * Get the shared CommandAPIImpl instance.
   * Allows the host to query or execute commands globally.
   */
  get commandAPI(): CommandAPIImpl {
    return this._commandAPI;
  }

  // -------------------------------------------------------------------------
  // HostAPIProvider interface implementation
  // -------------------------------------------------------------------------

  /**
   * Create a BookAPI implementation backed by Readest's book data stores.
   * Uses the current book key at call time for scoping.
   */
  createBookAPI(): BookAPI {
    const bookKey = this._bookKeyAccessor() ?? '';
    const accessors = this._createBookStoreAccessors();
    const provider = new ReadestBookDataProvider(bookKey, accessors);
    return new BookAPIImpl(provider);
  }

  /**
   * Create an AnnotationAPI implementation backed by Readest's bookDataStore.
   * Uses the current book key and a default pluginId ('readest').
   */
  createAnnotationAPI(): AnnotationAPI {
    const bookKey = this._bookKeyAccessor() ?? '';
    const accessors = this._createAnnotationStoreAccessors();

    // The annotation provider needs envConfig and settings for saving.
    // We use the global environmentConfig and current settings from the store.
    const currentSettings = useSettingsStore.getState().settings;
    const provider = new ReadestAnnotationDataProvider(
      bookKey,
      'readest', // default pluginId for host-created annotations
      accessors,
      environmentConfig,
      currentSettings,
    );

    return new AnnotationAPIImpl(provider);
  }

  /**
   * Create a UIAPI implementation that bridges to the pluginStore.
   *
   * Each UIAPI instance delegates display operations (notifications, modals,
   * progress, confirmations) to the shared ReadestUIHost. Registration
   * operations (panels, toolbar, context menu, status bar, settings pages)
   * are bridged to the pluginStore so React components can react.
   */
  createUIAPI(): UIAPI {
    const pluginStoreUI = this._createStoreBackedUIAPI();
    return pluginStoreUI;
  }

  /**
   * Create a CommandAPI implementation using the shared command registry.
   */
  createCommandAPI(): CommandAPI {
    return this._commandAPI;
  }

  /**
   * Create a SidecarAPI implementation for the given plugin manifest.
   * Uses the Tauri process spawner in desktop mode, or a web stub.
   *
   * @param manifest - The plugin manifest containing sidecar configuration
   */
  createSidecarAPI(manifest: PluginManifest): SidecarAPI {
    const sidecarConfig = manifest.sidecar ?? {
      command: '',
      args: [],
    };

    return new SidecarAPIImpl({
      sidecar: sidecarConfig,
      spawner: this._processSpawner,
    });
  }

  /**
   * Create a SettingsAPI implementation scoped to the given plugin.
   * Uses localStorage for persistence with previously saved settings
   * loaded as initial values.
   *
   * @param pluginId - The plugin ID for scoping
   */
  createSettingsAPI(pluginId: string): SettingsAPI {
    const initialSettings = loadPersistedSettings(pluginId);
    return new SettingsAPIImpl(pluginId, this._settingsPersister, initialSettings);
  }

  /**
   * Create a StorageAPI implementation scoped to the given plugin.
   * Uses the Tauri filesystem in desktop mode, or localStorage in web.
   *
   * @param pluginId - The plugin ID for scoping the data directory
   */
  createStorageAPI(pluginId: string): StorageAPI {
    const dataDir = `${this._pluginDataBasePath}/${pluginId}/data`;
    return new StorageAPIImpl(pluginId, dataDir, this._fileSystem);
  }

  // -------------------------------------------------------------------------
  // Private: store accessor factories
  // -------------------------------------------------------------------------

  /**
   * Create ReadestBookStoreAccessors from the Zustand stores.
   * All reads go through `getState()` so they are synchronous snapshots.
   */
  private _createBookStoreAccessors(): ReadestBookStoreAccessors {
    return {
      getBookData: (key: string) => {
        const data = useBookDataStore.getState().getBookData(key);
        if (!data) return null;
        return {
          book: data.book,
          config: data.config,
          bookDoc: data.bookDoc,
        };
      },
      getProgress: (key: string) => {
        const viewState = useReaderStore.getState().viewStates[key];
        return viewState?.progress ?? null;
      },
      getView: (key: string) => {
        const viewState = useReaderStore.getState().viewStates[key];
        return viewState?.view ?? null;
      },
      getCurrentSelection: () => {
        // Text selection is transient and not stored in a Zustand store.
        // For now, return null; a future integration can wire up the
        // text selector hook's state here.
        return null;
      },
    };
  }

  /**
   * Create ReadestAnnotationStoreAccessors from the Zustand stores.
   */
  private _createAnnotationStoreAccessors(): ReadestAnnotationStoreAccessors {
    return {
      getConfig: (key: string) => {
        return useBookDataStore.getState().getConfig(key);
      },
      updateBooknotes: (key: string, notes) => {
        return useBookDataStore.getState().updateBooknotes(key, notes);
      },
      saveConfig: (envConfig, bookKey, config, settings) => {
        useBookDataStore.getState().saveConfig(envConfig, bookKey, config, settings);
      },
      getView: (key: string) => {
        const viewState = useReaderStore.getState().viewStates[key];
        return viewState?.view ?? null;
      },
      getBookHash: (key: string) => {
        const data = useBookDataStore.getState().getBookData(key);
        return data?.book?.hash;
      },
    };
  }

  /**
   * Create a UIAPI implementation that bridges registration calls to the
   * pluginStore (for reactive rendering) and display calls to the ReadestUIHost.
   *
   * This builds a UIAPIImpl with a custom UIHost that hooks into both the
   * pluginStore and the ReadestUIHost for display operations.
   */
  private _createStoreBackedUIAPI(): UIAPI {
    const uiHost = this._uiHost;

    // Build a UIAPI that routes registrations to the Zustand store
    // and display operations to the ReadestUIHost
    const storeState = () => usePluginStore.getState();

    const uiAPI: UIAPI = {
      registerPanel(panelId: string, component: ComponentType<PanelProps>): Disposable {
        // Use a generic pluginId since the sandbox wraps this call
        // and the HostAPIProvider doesn't know the pluginId at this level.
        // The panelId itself is plugin-scoped (e.g., "booksmith.main-panel").
        const cleanup = storeState().registerPanel('', panelId, component);
        return { dispose: cleanup };
      },

      showPanel(panelId: string): void {
        storeState().setPanelVisible(panelId, true);
      },

      hidePanel(panelId: string): void {
        storeState().setPanelVisible(panelId, false);
      },

      registerToolbarButton(button: ToolbarButton): Disposable {
        const cleanup = storeState().registerToolbarButton(button);
        return { dispose: cleanup };
      },

      registerContextMenuItem(item: ContextMenuItem): Disposable {
        const cleanup = storeState().registerContextMenuItem(item);
        return { dispose: cleanup };
      },

      registerSettingsPage(component: ComponentType<SettingsProps>): Disposable {
        // Use empty pluginId — the sandbox layer provides scoping
        const cleanup = storeState().registerSettingsPage('', component);
        return { dispose: cleanup };
      },

      registerStatusBarItem(item: StatusBarItem): Disposable {
        const cleanup = storeState().registerStatusBarItem(item);
        return { dispose: cleanup };
      },

      updateStatusBarItem(itemId: string, updates: Partial<StatusBarItem>): void {
        storeState().updateStatusBarItem(itemId, updates);
      },

      showNotification(
        message: string,
        type?: 'info' | 'success' | 'warning' | 'error',
      ): void {
        uiHost.showNotification(message, type);
      },

      showProgress(
        title: string,
        task: (progress: ProgressReporter) => Promise<void>,
      ): Promise<void> {
        return uiHost.showProgress(title, task);
      },

      showModal(component: ComponentType<ModalProps>): Promise<void> {
        return uiHost.showModal(component);
      },

      showConfirm(title: string, message: string): Promise<boolean> {
        return uiHost.showConfirm(title, message);
      },
    };

    return uiAPI;
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a ReadestHostAPIProvider instance.
 * This is an async factory because it needs to resolve the plugin data
 * base path (which may involve Tauri IPC in desktop mode).
 *
 * @param bookKeyAccessor - Function returning the current active book key
 * @param eventDispatcher - The Readest event dispatcher for toast notifications
 * @returns A configured ReadestHostAPIProvider
 */
export async function createHostAPIProvider(
  bookKeyAccessor: () => string | null,
  eventDispatcher: EventDispatcherLike,
): Promise<ReadestHostAPIProvider> {
  const pluginDataBasePath = await getPluginDataBasePath();

  return new ReadestHostAPIProvider({
    bookKeyAccessor,
    eventDispatcher,
    pluginDataBasePath,
  });
}
