/**
 * @module plugins/providers/TauriFileSystem
 * Implements the SDK's FileSystem interface for plugin data persistence.
 *
 * In Tauri desktop environments, uses `@tauri-apps/plugin-fs` for real
 * filesystem operations. The data is stored under `$APPDATA/plugins/<pluginId>/data/`.
 *
 * In web environments, provides a localStorage-based fallback with the same API.
 */

import type { FileSystem } from '@readest/plugin-sdk';

// ---------------------------------------------------------------------------
// Tauri FileSystem
// ---------------------------------------------------------------------------

/**
 * Creates a FileSystem implementation backed by Tauri's filesystem plugin.
 * All operations are async and use the real filesystem via IPC.
 *
 * @returns A FileSystem suitable for Tauri desktop environments
 */
export function createTauriFileSystem(): FileSystem {
  return {
    async readFile(path: string): Promise<Uint8Array> {
      const { readFile } = await import('@tauri-apps/plugin-fs');
      return readFile(path);
    },

    async writeFile(path: string, data: Uint8Array): Promise<void> {
      const { writeFile } = await import('@tauri-apps/plugin-fs');
      await writeFile(path, data);
    },

    async deleteFile(path: string): Promise<void> {
      const { remove } = await import('@tauri-apps/plugin-fs');
      await remove(path);
    },

    async listFiles(path: string): Promise<string[]> {
      const { readDir } = await import('@tauri-apps/plugin-fs');
      const entries = await readDir(path);
      return entries
        .filter((entry) => !entry.isDirectory)
        .map((entry) => entry.name);
    },

    async exists(path: string): Promise<boolean> {
      const { exists } = await import('@tauri-apps/plugin-fs');
      return exists(path);
    },

    async mkdir(path: string): Promise<void> {
      const { mkdir, exists } = await import('@tauri-apps/plugin-fs');
      const dirExists = await exists(path);
      if (!dirExists) {
        await mkdir(path, { recursive: true });
      }
    },
  };
}

/**
 * Get the base data path for plugin storage in a Tauri environment.
 * Returns `$APPDATA/plugins/` which is the parent directory for all
 * plugin data directories.
 *
 * @returns The absolute path to the plugins data directory
 */
export async function getTauriPluginDataBasePath(): Promise<string> {
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  const appData = await appDataDir();
  return await join(appData, 'plugins');
}

// ---------------------------------------------------------------------------
// Web (localStorage) FileSystem Fallback
// ---------------------------------------------------------------------------

/**
 * Key prefix for localStorage-based file storage.
 */
const LS_PREFIX = '__readest_plugin_fs__:';

/**
 * Creates a FileSystem implementation backed by localStorage.
 * Used in web (non-Tauri) environments as a simple fallback.
 *
 * Files are stored as base64-encoded strings keyed by their path.
 * Directory listing is simulated by scanning matching keys.
 *
 * @returns A FileSystem suitable for web environments
 */
export function createWebFileSystem(): FileSystem {
  return {
    async readFile(path: string): Promise<Uint8Array> {
      const data = localStorage.getItem(LS_PREFIX + path);
      if (data === null) {
        throw new Error(`File not found: ${path}`);
      }
      return base64ToUint8Array(data);
    },

    async writeFile(path: string, data: Uint8Array): Promise<void> {
      localStorage.setItem(LS_PREFIX + path, uint8ArrayToBase64(data));
    },

    async deleteFile(path: string): Promise<void> {
      if (localStorage.getItem(LS_PREFIX + path) === null) {
        throw new Error(`File not found: ${path}`);
      }
      localStorage.removeItem(LS_PREFIX + path);
    },

    async listFiles(dirPath: string): Promise<string[]> {
      const normalizedDir = dirPath.endsWith('/') ? dirPath : dirPath + '/';
      const prefix = LS_PREFIX + normalizedDir;
      const files: string[] = [];

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) {
          const relativePath = key.substring(prefix.length);
          // Only return direct children (no subdirectory paths)
          if (!relativePath.includes('/')) {
            files.push(relativePath);
          }
        }
      }

      return files;
    },

    async exists(path: string): Promise<boolean> {
      return localStorage.getItem(LS_PREFIX + path) !== null;
    },

    async mkdir(_path: string): Promise<void> {
      // No-op for localStorage: directories are implicit
    },
  };
}

/**
 * Get the base data path for plugin storage in a web environment.
 * Uses a virtual path prefix since localStorage does not have real directories.
 *
 * @returns A virtual path string for the plugins data directory
 */
export function getWebPluginDataBasePath(): string {
  return '/readest/plugins';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Detect the current environment and return the appropriate FileSystem.
 *
 * @returns The appropriate FileSystem for the current environment
 */
export function createFileSystem(): FileSystem {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return createTauriFileSystem();
  }
  return createWebFileSystem();
}

/**
 * Get the plugin data base path for the current environment.
 *
 * @returns A promise resolving to the base path for plugin data storage
 */
export async function getPluginDataBasePath(): Promise<string> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return getTauriPluginDataBasePath();
  }
  return getWebPluginDataBasePath();
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Uint8Array to a base64 string.
 *
 * @param data - The binary data to encode
 * @returns The base64-encoded string
 */
function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

/**
 * Convert a base64 string to a Uint8Array.
 *
 * @param base64 - The base64-encoded string
 * @returns The decoded binary data
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
