/**
 * @module plugins/providers/TauriProcessSpawner
 * Implements the SDK's ProcessSpawner interface using the Tauri shell plugin.
 *
 * For non-Tauri environments (web browser), a stub implementation is provided
 * that throws an error on spawn.
 */

import type {
  ProcessSpawner,
  SpawnedProcess,
} from '@readest/plugin-sdk';

// ---------------------------------------------------------------------------
// Buffer-like wrapper
// ---------------------------------------------------------------------------

/**
 * A minimal Buffer-like wrapper for string data.
 * The SDK's SidecarAPIImpl calls `.toString()` on data from stdout/stderr,
 * so we wrap the string to satisfy the Buffer interface at runtime without
 * depending on the Node.js Buffer global.
 */
function toBufferLike(str: string): Buffer {
  // In environments where Buffer is available (Node.js, Next.js with polyfills),
  // use it directly. Otherwise, create a minimal shim object.
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str);
  }
  // Minimal shim: only needs toString() for SidecarAPIImpl compatibility
  return { toString: () => str } as unknown as Buffer;
}

// ---------------------------------------------------------------------------
// Tauri Process Spawner
// ---------------------------------------------------------------------------

/**
 * Creates a ProcessSpawner that uses the Tauri shell plugin to spawn
 * sidecar processes. Dynamically imports `@tauri-apps/plugin-shell`
 * at spawn time.
 *
 * @returns A ProcessSpawner suitable for Tauri desktop environments
 */
export function createTauriProcessSpawner(): ProcessSpawner {
  return {
    spawn(command: string, args: string[]): SpawnedProcess {
      // We need to return a SpawnedProcess synchronously, but Tauri's
      // Command.spawn() is async. We bridge this by creating a wrapper
      // that defers the actual spawn and queues event handler registrations.
      const exitHandlers: Array<(code: number | null) => void> = [];
      const errorHandlers: Array<(error: Error) => void> = [];
      const stdoutHandlers: Array<(data: Buffer) => void> = [];
      const stderrHandlers: Array<(data: Buffer) => void> = [];

      let killed = false;
      let childPid: number | undefined;
      let childKill: (() => void) | undefined;

      // Kick off the async spawn
      const spawnPromise = (async () => {
        try {
          const { Command } = await import('@tauri-apps/plugin-shell');
          const cmd = Command.create(command, args);

          cmd.on('close', (data) => {
            const code = data.code;
            for (const handler of exitHandlers) {
              handler(code);
            }
          });

          cmd.on('error', (errorMsg: string) => {
            const error = new Error(errorMsg);
            for (const handler of errorHandlers) {
              handler(error);
            }
          });

          cmd.stdout.on('data', (line: string) => {
            const buf = toBufferLike(line);
            for (const handler of stdoutHandlers) {
              handler(buf);
            }
          });

          cmd.stderr.on('data', (line: string) => {
            const buf = toBufferLike(line);
            for (const handler of stderrHandlers) {
              handler(buf);
            }
          });

          const child = await cmd.spawn();
          childPid = child.pid;
          childKill = () => {
            void child.kill();
          };

          // If kill was requested before spawn completed, kill now
          if (killed && childKill) {
            childKill();
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          for (const handler of errorHandlers) {
            handler(error);
          }
        }
      })();

      // Suppress unhandled promise rejection
      spawnPromise.catch(() => {});

      const process: SpawnedProcess = {
        get pid() {
          return childPid;
        },

        kill(_signal?: string): boolean {
          killed = true;
          if (childKill) {
            childKill();
            return true;
          }
          // Kill will be applied once spawn completes
          return true;
        },

        on: ((event: string, handler: ((...args: unknown[]) => void)) => {
          if (event === 'exit') {
            exitHandlers.push(handler as unknown as (code: number | null) => void);
          } else if (event === 'error') {
            errorHandlers.push(handler as unknown as (error: Error) => void);
          }
        }) as {
          (event: 'exit', handler: (code: number | null) => void): void;
          (event: 'error', handler: (error: Error) => void): void;
        },

        stdout: {
          on(_event: string, handler: (data: Buffer) => void): void {
            stdoutHandlers.push(handler);
          },
        },

        stderr: {
          on(_event: string, handler: (data: Buffer) => void): void {
            stderrHandlers.push(handler);
          },
        },
      };

      return process;
    },
  };
}

// ---------------------------------------------------------------------------
// Web Stub
// ---------------------------------------------------------------------------

/**
 * Creates a stub ProcessSpawner for non-Tauri (web) environments.
 * All spawn attempts throw an error indicating that sidecar processes
 * are not supported in the web environment.
 *
 * @returns A ProcessSpawner that always throws on spawn
 */
export function createWebProcessSpawnerStub(): ProcessSpawner {
  return {
    spawn(_command: string, _args: string[]): SpawnedProcess {
      throw new Error(
        'Sidecar processes are not supported in the web environment. ' +
        'Sidecar features require the Tauri desktop application.',
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Detect the current environment and return the appropriate ProcessSpawner.
 * Uses the Tauri spawner in desktop environments and the stub in web.
 *
 * @returns The appropriate ProcessSpawner for the current environment
 */
export function createProcessSpawner(): ProcessSpawner {
  // Check if we're in a Tauri environment
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return createTauriProcessSpawner();
  }
  return createWebProcessSpawnerStub();
}
