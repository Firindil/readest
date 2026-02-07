/**
 * @module plugins/providers/ReadestUIHost
 * Implements the SDK's UIHost interface by bridging to Readest's
 * event dispatcher for notifications and providing in-memory registries
 * for panels, toolbar buttons, context menu items, status bar items,
 * and settings pages.
 *
 * The registries are exposed as read-only properties so that Zustand
 * stores or React components can read them reactively.
 */

import type { ComponentType } from 'react';
import type {
  ModalProps,
  ProgressReporter,
} from '@readest/plugin-sdk';
import type { UIHost } from '@readest/plugin-sdk';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Interface for the host event dispatcher.
 * Matches the shape of Readest's eventDispatcher singleton.
 */
export interface EventDispatcherLike {
  /** Dispatch an asynchronous event with optional detail payload */
  dispatch(event: string, detail?: unknown): Promise<void>;
}

/**
 * Implements the SDK's UIHost interface for Readest.
 *
 * Handles:
 * - Notifications via the host event dispatcher ('toast' events)
 * - Progress overlays via a callback-based pattern
 * - Modal dialogs via a Promise-based pattern
 * - Confirmation dialogs via a Promise-based pattern
 */
export class ReadestUIHost implements UIHost {
  private readonly _eventDispatcher: EventDispatcherLike;

  /** Callback to display a modal component. Set by the host UI layer. */
  private _modalHandler:
    | ((component: ComponentType<ModalProps>) => Promise<void>)
    | null = null;

  /** Callback to display a confirmation dialog. Set by the host UI layer. */
  private _confirmHandler:
    | ((title: string, message: string) => Promise<boolean>)
    | null = null;

  /** Callback to display a progress overlay. Set by the host UI layer. */
  private _progressHandler:
    | ((title: string, task: (progress: ProgressReporter) => Promise<void>) => Promise<void>)
    | null = null;

  /**
   * Create a new ReadestUIHost.
   *
   * @param eventDispatcher - The Readest event dispatcher for toast notifications
   */
  constructor(eventDispatcher: EventDispatcherLike) {
    this._eventDispatcher = eventDispatcher;
  }

  /**
   * Register a handler for showing modal dialogs.
   * Called by the host UI layer during initialization.
   *
   * @param handler - A function that renders a modal component and resolves when closed
   */
  setModalHandler(
    handler: (component: ComponentType<ModalProps>) => Promise<void>,
  ): void {
    this._modalHandler = handler;
  }

  /**
   * Register a handler for showing confirmation dialogs.
   * Called by the host UI layer during initialization.
   *
   * @param handler - A function that shows a confirm dialog and resolves with user's choice
   */
  setConfirmHandler(
    handler: (title: string, message: string) => Promise<boolean>,
  ): void {
    this._confirmHandler = handler;
  }

  /**
   * Register a handler for showing progress overlays.
   * Called by the host UI layer during initialization.
   *
   * @param handler - A function that shows a progress overlay while executing a task
   */
  setProgressHandler(
    handler: (title: string, task: (progress: ProgressReporter) => Promise<void>) => Promise<void>,
  ): void {
    this._progressHandler = handler;
  }

  /**
   * Show a notification to the user via the Readest toast system.
   *
   * @param message - The notification message
   * @param type - Notification severity level (default: 'info')
   */
  showNotification(
    message: string,
    type: 'info' | 'success' | 'warning' | 'error' = 'info',
  ): void {
    void this._eventDispatcher.dispatch('toast', {
      type,
      message,
      timeout: type === 'error' ? 5000 : 3000,
    });
  }

  /**
   * Show a progress dialog for a long-running task.
   * If no progress handler is registered, the task executes silently.
   *
   * @param title - Title of the progress dialog
   * @param task - Async function receiving a progress reporter
   */
  async showProgress(
    title: string,
    task: (progress: ProgressReporter) => Promise<void>,
  ): Promise<void> {
    if (this._progressHandler) {
      return this._progressHandler(title, task);
    }

    // Fallback: execute the task without visual progress
    const reporter: ProgressReporter = {
      report(_progress: number, _message?: string) {
        // No-op in fallback mode
      },
    };
    await task(reporter);
  }

  /**
   * Show a modal dialog with a custom React component.
   * If no modal handler is registered, logs a warning and resolves immediately.
   *
   * @param component - React component to render in the modal
   */
  async showModal(component: ComponentType<ModalProps>): Promise<void> {
    if (this._modalHandler) {
      return this._modalHandler(component);
    }
    console.warn('[ReadestUIHost] No modal handler registered; modal request ignored');
  }

  /**
   * Show a confirmation dialog.
   * If no confirm handler is registered, defaults to true.
   *
   * @param title - Dialog title
   * @param message - Dialog message
   * @returns True if the user confirmed, false otherwise
   */
  async showConfirm(title: string, message: string): Promise<boolean> {
    if (this._confirmHandler) {
      return this._confirmHandler(title, message);
    }
    // Fallback: auto-confirm
    console.warn('[ReadestUIHost] No confirm handler registered; auto-confirming');
    return true;
  }
}
