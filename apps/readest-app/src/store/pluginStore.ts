/**
 * @module store/pluginStore
 * Zustand store for plugin runtime state in Readest.
 *
 * Holds all UI registrations (panels, toolbar buttons, context menu items,
 * status bar items, settings pages) that plugins create through the UIAPI,
 * as well as overall plugin system state (initialized, pluginCount).
 *
 * The ReadestHostAPIProvider creates UIAPI instances whose registration
 * methods call the actions on this store, allowing React components to
 * reactively render plugin-contributed UI elements.
 */

import type { ComponentType } from 'react';
import { create } from 'zustand';
import type {
  ToolbarButton,
  ContextMenuItem,
  StatusBarItem,
  PanelProps,
  SettingsProps,
} from '@readest/plugin-sdk';

// ---------------------------------------------------------------------------
// Entry types for registered UI elements
// ---------------------------------------------------------------------------

/**
 * A registered plugin panel with its ownership metadata.
 */
export interface PluginPanelEntry {
  /** The plugin that registered this panel */
  pluginId: string;
  /** The unique panel identifier */
  panelId: string;
  /** The React component to render for this panel */
  component: ComponentType<PanelProps>;
  /** Whether the panel is currently visible */
  visible: boolean;
}

/**
 * A registered plugin settings page.
 */
export interface PluginSettingsEntry {
  /** The plugin that registered this settings page */
  pluginId: string;
  /** The React component to render for the settings page */
  component: ComponentType<SettingsProps>;
}

// ---------------------------------------------------------------------------
// Store state interface
// ---------------------------------------------------------------------------

/**
 * State shape for the plugin Zustand store.
 */
interface PluginStoreState {
  /** Plugin panel registrations, keyed by panelId */
  pluginPanels: Map<string, PluginPanelEntry>;
  /** Registered toolbar buttons from plugins */
  pluginToolbarButtons: ToolbarButton[];
  /** Registered context menu items from plugins */
  pluginContextMenuItems: ContextMenuItem[];
  /** Registered status bar items from plugins */
  pluginStatusBarItems: StatusBarItem[];
  /** Plugin settings page registrations, keyed by pluginId */
  pluginSettingsPages: Map<string, PluginSettingsEntry>;

  /** Whether the plugin system has completed initialization */
  initialized: boolean;
  /** The number of loaded plugins */
  pluginCount: number;

  // --- Panel actions ---

  /**
   * Register a panel for a plugin. Returns a cleanup function.
   * @param pluginId - The owning plugin's ID
   * @param panelId - The unique panel identifier
   * @param component - The React component to render
   * @returns A function that unregisters the panel when called
   */
  registerPanel: (
    pluginId: string,
    panelId: string,
    component: ComponentType<PanelProps>,
  ) => () => void;

  /**
   * Unregister a panel by its ID.
   * @param panelId - The panel to remove
   */
  unregisterPanel: (panelId: string) => void;

  /**
   * Set the visibility of a panel.
   * @param panelId - The panel to update
   * @param visible - Whether the panel should be visible
   */
  setPanelVisible: (panelId: string, visible: boolean) => void;

  // --- Toolbar actions ---

  /**
   * Register a toolbar button. Returns a cleanup function.
   * @param button - The toolbar button configuration
   * @returns A function that unregisters the button when called
   */
  registerToolbarButton: (button: ToolbarButton) => () => void;

  /**
   * Unregister a toolbar button by its ID.
   * @param buttonId - The button to remove
   */
  unregisterToolbarButton: (buttonId: string) => void;

  // --- Context menu actions ---

  /**
   * Register a context menu item. Returns a cleanup function.
   * @param item - The context menu item configuration
   * @returns A function that unregisters the item when called
   */
  registerContextMenuItem: (item: ContextMenuItem) => () => void;

  /**
   * Unregister a context menu item by its ID.
   * @param itemId - The item to remove
   */
  unregisterContextMenuItem: (itemId: string) => void;

  // --- Status bar actions ---

  /**
   * Register a status bar item. Returns a cleanup function.
   * @param item - The status bar item configuration
   * @returns A function that unregisters the item when called
   */
  registerStatusBarItem: (item: StatusBarItem) => () => void;

  /**
   * Unregister a status bar item by its ID.
   * @param itemId - The item to remove
   */
  unregisterStatusBarItem: (itemId: string) => void;

  /**
   * Update an existing status bar item's properties.
   * @param itemId - The item to update
   * @param updates - Partial updates to merge
   */
  updateStatusBarItem: (itemId: string, updates: Partial<StatusBarItem>) => void;

  // --- Settings page actions ---

  /**
   * Register a settings page for a plugin. Returns a cleanup function.
   * @param pluginId - The owning plugin's ID
   * @param component - The React component to render
   * @returns A function that unregisters the settings page when called
   */
  registerSettingsPage: (
    pluginId: string,
    component: ComponentType<SettingsProps>,
  ) => () => void;

  /**
   * Unregister a settings page by plugin ID.
   * @param pluginId - The plugin whose settings page to remove
   */
  unregisterSettingsPage: (pluginId: string) => void;

  // --- System state actions ---

  /**
   * Set whether the plugin system is initialized.
   * @param initialized - Initialization state
   */
  setInitialized: (initialized: boolean) => void;

  /**
   * Set the count of loaded plugins.
   * @param count - The plugin count
   */
  setPluginCount: (count: number) => void;
}

// ---------------------------------------------------------------------------
// Store creation
// ---------------------------------------------------------------------------

/**
 * Zustand store for plugin system runtime state.
 *
 * Follows the same `create<State>((set, get) => ({ ... }))` pattern
 * used by all other Readest stores.
 */
export const usePluginStore = create<PluginStoreState>((set, get) => ({
  // Initial state
  pluginPanels: new Map(),
  pluginToolbarButtons: [],
  pluginContextMenuItems: [],
  pluginStatusBarItems: [],
  pluginSettingsPages: new Map(),
  initialized: false,
  pluginCount: 0,

  // --- Panel actions ---

  registerPanel: (
    pluginId: string,
    panelId: string,
    component: ComponentType<PanelProps>,
  ) => {
    const entry: PluginPanelEntry = { pluginId, panelId, component, visible: false };
    set((state) => {
      const newPanels = new Map(state.pluginPanels);
      newPanels.set(panelId, entry);
      return { pluginPanels: newPanels };
    });
    return () => get().unregisterPanel(panelId);
  },

  unregisterPanel: (panelId: string) => {
    set((state) => {
      const newPanels = new Map(state.pluginPanels);
      newPanels.delete(panelId);
      return { pluginPanels: newPanels };
    });
  },

  setPanelVisible: (panelId: string, visible: boolean) => {
    set((state) => {
      const existing = state.pluginPanels.get(panelId);
      if (!existing) return state;
      const newPanels = new Map(state.pluginPanels);
      newPanels.set(panelId, { ...existing, visible });
      return { pluginPanels: newPanels };
    });
  },

  // --- Toolbar actions ---

  registerToolbarButton: (button: ToolbarButton) => {
    set((state) => ({
      pluginToolbarButtons: [
        ...state.pluginToolbarButtons.filter((b) => b.id !== button.id),
        button,
      ],
    }));
    return () => get().unregisterToolbarButton(button.id);
  },

  unregisterToolbarButton: (buttonId: string) => {
    set((state) => ({
      pluginToolbarButtons: state.pluginToolbarButtons.filter((b) => b.id !== buttonId),
    }));
  },

  // --- Context menu actions ---

  registerContextMenuItem: (item: ContextMenuItem) => {
    set((state) => ({
      pluginContextMenuItems: [
        ...state.pluginContextMenuItems.filter((i) => i.id !== item.id),
        item,
      ],
    }));
    return () => get().unregisterContextMenuItem(item.id);
  },

  unregisterContextMenuItem: (itemId: string) => {
    set((state) => ({
      pluginContextMenuItems: state.pluginContextMenuItems.filter((i) => i.id !== itemId),
    }));
  },

  // --- Status bar actions ---

  registerStatusBarItem: (item: StatusBarItem) => {
    set((state) => ({
      pluginStatusBarItems: [
        ...state.pluginStatusBarItems.filter((i) => i.id !== item.id),
        item,
      ],
    }));
    return () => get().unregisterStatusBarItem(item.id);
  },

  unregisterStatusBarItem: (itemId: string) => {
    set((state) => ({
      pluginStatusBarItems: state.pluginStatusBarItems.filter((i) => i.id !== itemId),
    }));
  },

  updateStatusBarItem: (itemId: string, updates: Partial<StatusBarItem>) => {
    set((state) => ({
      pluginStatusBarItems: state.pluginStatusBarItems.map((item) =>
        item.id === itemId ? { ...item, ...updates } : item,
      ),
    }));
  },

  // --- Settings page actions ---

  registerSettingsPage: (
    pluginId: string,
    component: ComponentType<SettingsProps>,
  ) => {
    const entry: PluginSettingsEntry = { pluginId, component };
    set((state) => {
      const newPages = new Map(state.pluginSettingsPages);
      newPages.set(pluginId, entry);
      return { pluginSettingsPages: newPages };
    });
    return () => get().unregisterSettingsPage(pluginId);
  },

  unregisterSettingsPage: (pluginId: string) => {
    set((state) => {
      const newPages = new Map(state.pluginSettingsPages);
      newPages.delete(pluginId);
      return { pluginSettingsPages: newPages };
    });
  },

  // --- System state actions ---

  setInitialized: (initialized: boolean) => set({ initialized }),
  setPluginCount: (count: number) => set({ pluginCount: count }),
}));
