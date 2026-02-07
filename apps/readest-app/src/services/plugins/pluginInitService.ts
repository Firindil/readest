/**
 * @module plugins/pluginInitService
 * Plugin system initialization and shutdown service for Readest.
 *
 * Called at app startup to discover, load, and activate plugins.
 * Called at app shutdown to deactivate and unload all plugins.
 *
 * Uses the SDK's PluginLoader for the full plugin lifecycle, with
 * ReadestHostAPIProvider supplying the host-side API factories and
 * Tauri FS / dynamic import for plugin discovery and module loading.
 */

import type {
  ModuleLoader,
  ManifestReader,
  DirectoryScanner,
  ReadestPlugin,
} from '@readest/plugin-sdk';
import { PluginLoader } from '@readest/plugin-sdk';

import { usePluginStore } from '@/store/pluginStore';
import { eventDispatcher } from '@/utils/event';

import {
  ReadestHostAPIProvider,
  createHostAPIProvider,
} from './ReadestHostAPIProvider';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** The active PluginLoader instance, created during initialization */
let _loader: PluginLoader | null = null;

/** The active HostAPIProvider instance */
let _hostProvider: ReadestHostAPIProvider | null = null;

/** Accessor for the current book key */
let _bookKeyAccessor: (() => string | null) | null = null;

// ---------------------------------------------------------------------------
// I/O abstractions for PluginLoader
// ---------------------------------------------------------------------------

/**
 * Create a ManifestReader that reads plugin.json files.
 *
 * In a Tauri environment, uses the Tauri FS plugin.
 * In a web environment, uses fetch() to load from a well-known path.
 *
 * @returns A ManifestReader function
 */
function createManifestReader(): ManifestReader {
  return async (manifestPath: string): Promise<Record<string, unknown>> => {
    // Try Tauri FS first
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        const content = await readTextFile(manifestPath);
        return JSON.parse(content) as Record<string, unknown>;
      } catch (error) {
        throw new Error(
          `Failed to read manifest at "${manifestPath}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Web fallback: fetch
    try {
      const response = await fetch(manifestPath);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Failed to read manifest at "${manifestPath}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}

/**
 * Create a ModuleLoader that dynamically imports plugin entry points.
 *
 * Uses the standard ES dynamic import, which works in both Tauri and
 * web environments for plugins bundled as ES modules.
 *
 * @returns A ModuleLoader function
 */
function createModuleLoader(): ModuleLoader {
  return async (
    modulePath: string,
  ): Promise<{ default: new () => ReadestPlugin }> => {
    try {
      // Dynamic import works for both file:// (Tauri) and http:// (web) URLs
      const mod = await import(/* webpackIgnore: true */ modulePath);
      if (!mod.default) {
        throw new Error(
          `Module at "${modulePath}" does not have a default export`,
        );
      }
      return mod as { default: new () => ReadestPlugin };
    } catch (error) {
      throw new Error(
        `Failed to load module at "${modulePath}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}

/**
 * Create a DirectoryScanner that finds plugin.json files in a directory.
 *
 * In a Tauri environment, reads the directory via the Tauri FS plugin.
 * In a web environment, returns an empty array (web plugins would need
 * a manifest registry instead of directory scanning).
 *
 * @returns A DirectoryScanner function
 */
function createDirectoryScanner(): DirectoryScanner {
  return async (pluginDir: string): Promise<string[]> => {
    // Tauri environment: scan the filesystem
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        const { readDir, exists } = await import('@tauri-apps/plugin-fs');
        const { join } = await import('@tauri-apps/api/path');

        const dirExists = await exists(pluginDir);
        if (!dirExists) {
          console.log(`[Plugins] Plugin directory does not exist: ${pluginDir}`);
          return [];
        }

        const entries = await readDir(pluginDir);
        const manifestPaths: string[] = [];

        for (const entry of entries) {
          if (entry.isDirectory) {
            const manifestPath = await join(pluginDir, entry.name, 'plugin.json');
            const manifestExists = await exists(manifestPath);
            if (manifestExists) {
              manifestPaths.push(manifestPath);
            }
          }
        }

        return manifestPaths;
      } catch (error) {
        console.error('[Plugins] Error scanning plugin directory:', error);
        return [];
      }
    }

    // Web environment: no directory scanning available
    console.log('[Plugins] Directory scanning not available in web environment');
    return [];
  };
}

// ---------------------------------------------------------------------------
// Plugin directory resolution
// ---------------------------------------------------------------------------

/**
 * Get the base directory where plugins are installed.
 *
 * In Tauri: `$APPDATA/plugins/`
 * In web: not applicable (returns empty string)
 *
 * @returns The absolute path to the plugins directory
 */
async function getPluginsBaseDirectory(): Promise<string> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { appDataDir, join } = await import('@tauri-apps/api/path');
      const appData = await appDataDir();
      return await join(appData, 'plugins');
    } catch (error) {
      console.error('[Plugins] Failed to resolve plugins directory:', error);
      return '';
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the plugin system.
 *
 * Called once when the Reader component mounts. Creates the HostAPIProvider
 * and PluginLoader, discovers plugins in the plugins directory, and loads
 * all valid plugins.
 *
 * @param bookKeyAccessor - A function that returns the current active book key
 */
export async function initializePlugins(
  bookKeyAccessor: () => string | null,
): Promise<void> {
  _bookKeyAccessor = bookKeyAccessor;

  const { setInitialized, setPluginCount } = usePluginStore.getState();

  try {
    // 1. Create the host API provider
    _hostProvider = await createHostAPIProvider(bookKeyAccessor, eventDispatcher);

    // 2. Create the PluginLoader with I/O abstractions
    _loader = new PluginLoader(_hostProvider, {
      moduleLoader: createModuleLoader(),
      manifestReader: createManifestReader(),
      directoryScanner: createDirectoryScanner(),
    });

    // 3. Discover plugins in the plugins directory
    const pluginsDir = await getPluginsBaseDirectory();

    if (pluginsDir) {
      const discovered = await _loader.discoverPlugins(pluginsDir);

      console.log(
        `[Plugins] Discovered ${discovered.length} plugin(s) in ${pluginsDir}`,
      );

      // 4. Load all valid plugins
      let loadedCount = 0;
      for (const plugin of discovered) {
        if (plugin.manifest) {
          try {
            await _loader.loadPlugin(plugin.manifestPath, { activate: true });
            loadedCount++;
            console.log(
              `[Plugins] Loaded plugin: ${plugin.manifest.name} (${plugin.manifest.id})`,
            );
          } catch (error) {
            console.error(
              `[Plugins] Failed to load plugin from ${plugin.manifestPath}:`,
              error,
            );
          }
        } else {
          console.warn(
            `[Plugins] Skipping invalid manifest at ${plugin.manifestPath}: ${plugin.errors.join('; ')}`,
          );
        }
      }

      // 5. Update the plugin store
      setPluginCount(loadedCount);
    } else {
      setPluginCount(0);
    }

    setInitialized(true);
    console.log('[Plugins] Plugin system initialized');
  } catch (error) {
    console.error('[Plugins] Failed to initialize plugin system:', error);
    setPluginCount(0);
    setInitialized(true); // Mark as initialized even on error so UI doesn't hang
  }
}

/**
 * Shut down the plugin system.
 *
 * Called when the Reader component unmounts. Unloads all plugins via the
 * PluginLoader, which calls each plugin's onUnload() and disposes resources.
 */
export async function shutdownPlugins(): Promise<void> {
  const { setInitialized, setPluginCount } = usePluginStore.getState();

  if (_loader) {
    try {
      await _loader.unloadAll();
      console.log('[Plugins] All plugins unloaded');
    } catch (error) {
      console.error('[Plugins] Error during plugin shutdown:', error);
    }
  }

  _loader = null;
  _hostProvider = null;
  _bookKeyAccessor = null;

  setPluginCount(0);
  setInitialized(false);

  console.log('[Plugins] Plugin system shut down');
}

/**
 * Get the current active book key from the host application.
 *
 * @returns The current book key, or null if no book is active
 */
export function getCurrentBookKey(): string | null {
  return _bookKeyAccessor?.() ?? null;
}

/**
 * Get the active PluginLoader instance.
 * Returns null if the plugin system has not been initialized.
 *
 * Useful for the host UI to query loaded plugins, enable/disable them, etc.
 *
 * @returns The PluginLoader instance or null
 */
export function getPluginLoader(): PluginLoader | null {
  return _loader;
}

/**
 * Get the active HostAPIProvider instance.
 * Returns null if the plugin system has not been initialized.
 *
 * Useful for the host UI to access the shared ReadestUIHost or CommandAPI.
 *
 * @returns The ReadestHostAPIProvider instance or null
 */
export function getHostAPIProvider(): ReadestHostAPIProvider | null {
  return _hostProvider;
}
