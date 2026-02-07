/**
 * @module plugins/providers/ReadestAnnotationDataProvider
 * Implements the SDK's AnnotationDataProvider interface by reading from and
 * writing to Readest's bookDataStore (BookConfig.booknotes).
 *
 * Annotation layers are managed in-memory within this provider instance,
 * as Readest does not have a native layer concept.
 */

import type {
  Annotation as SDKAnnotation,
  NewAnnotation as SDKNewAnnotation,
  AnnotationLayer as SDKAnnotationLayer,
} from '@readest/plugin-sdk';
import type { AnnotationDataProvider } from '@readest/plugin-sdk';

import type { BookNote, BookConfig } from '@/types/book';
import type { FoliateView } from '@/types/view';
import type { EnvConfigType } from '@/services/environment';
import type { SystemSettings } from '@/types/settings';

import {
  mapBookNoteToSDKAnnotation,
  mapSDKAnnotationToBookNote,
} from '../typeMappers';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Store accessor interface for annotation CRUD operations.
 */
export interface ReadestAnnotationStoreAccessors {
  /** Get the BookConfig (including booknotes) for a book key */
  getConfig: (key: string) => BookConfig | null;

  /** Update the booknotes array for a book key and return the updated config */
  updateBooknotes: (key: string, notes: BookNote[]) => BookConfig | undefined;

  /** Save the config to disk */
  saveConfig: (
    envConfig: EnvConfigType,
    bookKey: string,
    config: BookConfig,
    settings: SystemSettings,
  ) => void;

  /** Get the FoliateView for rendering annotations in the view */
  getView: (key: string) => FoliateView | null;

  /** Get the book hash for the given book key */
  getBookHash: (key: string) => string | undefined;
}

/**
 * Implements the SDK's AnnotationDataProvider interface.
 * Reads and writes BookNote objects in the bookDataStore, and manages
 * annotation layers in memory.
 */
export class ReadestAnnotationDataProvider implements AnnotationDataProvider {
  private readonly _bookKey: string;
  private readonly _pluginId: string;
  private readonly _accessors: ReadestAnnotationStoreAccessors;
  private readonly _envConfig: EnvConfigType;
  private readonly _settings: SystemSettings;

  /** In-memory annotation layers, keyed by layer ID */
  private readonly _layers: Map<string, SDKAnnotationLayer> = new Map();

  /**
   * Create a new ReadestAnnotationDataProvider.
   *
   * @param bookKey - The Readest book key for the current book view
   * @param pluginId - The plugin ID to attribute new annotations to
   * @param accessors - Store accessor functions
   * @param envConfig - The environment configuration for saving
   * @param settings - The system settings for saving
   */
  constructor(
    bookKey: string,
    pluginId: string,
    accessors: ReadestAnnotationStoreAccessors,
    envConfig: EnvConfigType,
    settings: SystemSettings,
  ) {
    this._bookKey = bookKey;
    this._pluginId = pluginId;
    this._accessors = accessors;
    this._envConfig = envConfig;
    this._settings = settings;
  }

  /**
   * Get annotations, optionally filtered by chapter index.
   * Only returns non-deleted annotations.
   *
   * @param chapterIndex - Optional chapter index to filter by
   * @returns Array of SDK Annotations
   */
  async getAnnotations(chapterIndex?: number): Promise<SDKAnnotation[]> {
    const config = this._accessors.getConfig(this._bookKey);
    if (!config?.booknotes) return [];

    const activeNotes = config.booknotes.filter((note) => !note.deletedAt);

    const annotations = activeNotes.map((note) =>
      mapBookNoteToSDKAnnotation(note, this._pluginId),
    );

    if (chapterIndex !== undefined) {
      return annotations.filter((a) => a.chapterIndex === chapterIndex);
    }

    return annotations;
  }

  /**
   * Create a new annotation.
   * Converts the SDK NewAnnotation to a Readest BookNote, adds it to the
   * bookDataStore, renders it in the view, and persists to config.
   *
   * @param annotation - The SDK NewAnnotation data
   * @returns The created SDK Annotation with assigned ID and timestamps
   */
  async createAnnotation(annotation: SDKNewAnnotation): Promise<SDKAnnotation> {
    const bookHash = this._accessors.getBookHash(this._bookKey);
    const newNote = mapSDKAnnotationToBookNote(annotation, bookHash);

    // Add to existing booknotes
    const config = this._accessors.getConfig(this._bookKey);
    const existingNotes = config?.booknotes ?? [];
    const updatedNotes = [...existingNotes, newNote];

    const updatedConfig = this._accessors.updateBooknotes(this._bookKey, updatedNotes);

    // Render in the view if available
    const view = this._accessors.getView(this._bookKey);
    if (view) {
      try {
        view.addAnnotation(newNote);
      } catch {
        // Non-fatal: the annotation is stored even if view rendering fails
      }
    }

    // Persist to disk
    if (updatedConfig) {
      this._accessors.saveConfig(this._envConfig, this._bookKey, updatedConfig, this._settings);
    }

    return mapBookNoteToSDKAnnotation(newNote, this._pluginId);
  }

  /**
   * Create multiple annotations in a batch.
   *
   * @param annotations - Array of SDK NewAnnotation data
   * @returns Array of created SDK Annotations
   */
  async createAnnotations(annotations: SDKNewAnnotation[]): Promise<SDKAnnotation[]> {
    const bookHash = this._accessors.getBookHash(this._bookKey);
    const newNotes = annotations.map((a) => mapSDKAnnotationToBookNote(a, bookHash));

    // Add all to existing booknotes
    const config = this._accessors.getConfig(this._bookKey);
    const existingNotes = config?.booknotes ?? [];
    const updatedNotes = [...existingNotes, ...newNotes];

    const updatedConfig = this._accessors.updateBooknotes(this._bookKey, updatedNotes);

    // Render each in the view
    const view = this._accessors.getView(this._bookKey);
    if (view) {
      for (const note of newNotes) {
        try {
          view.addAnnotation(note);
        } catch {
          // Non-fatal
        }
      }
    }

    // Persist
    if (updatedConfig) {
      this._accessors.saveConfig(this._envConfig, this._bookKey, updatedConfig, this._settings);
    }

    return newNotes.map((note) => mapBookNoteToSDKAnnotation(note, this._pluginId));
  }

  /**
   * Delete an annotation by ID.
   * Performs a soft delete by setting the deletedAt timestamp, then removes
   * the annotation from the view.
   *
   * @param annotationId - The ID of the annotation to delete
   */
  async deleteAnnotation(annotationId: string): Promise<void> {
    const config = this._accessors.getConfig(this._bookKey);
    if (!config?.booknotes) return;

    const noteIndex = config.booknotes.findIndex((n) => n.id === annotationId);
    if (noteIndex === -1) return;

    // Soft delete
    const updatedNotes = [...config.booknotes];
    const note = updatedNotes[noteIndex];
    if (note) {
      updatedNotes[noteIndex] = {
        ...note,
        deletedAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    const updatedConfig = this._accessors.updateBooknotes(this._bookKey, updatedNotes);

    // Remove from view
    const view = this._accessors.getView(this._bookKey);
    if (view && note) {
      try {
        view.addAnnotation(note, true); // remove=true
      } catch {
        // Non-fatal
      }
    }

    // Persist
    if (updatedConfig) {
      this._accessors.saveConfig(this._envConfig, this._bookKey, updatedConfig, this._settings);
    }
  }

  /**
   * Create a new annotation layer.
   * Layers are managed in memory only.
   *
   * @param layer - The layer definition
   * @returns The ID of the created layer
   */
  async createLayer(layer: SDKAnnotationLayer): Promise<string> {
    const id = layer.id ?? `layer-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const newLayer: SDKAnnotationLayer = {
      ...layer,
      id,
      pluginId: this._pluginId,
    };
    this._layers.set(id, newLayer);
    return id;
  }

  /**
   * Get an annotation layer by its ID.
   *
   * @param layerId - The layer ID
   * @returns The layer or null if not found
   */
  async getLayer(layerId: string): Promise<SDKAnnotationLayer | null> {
    return this._layers.get(layerId) ?? null;
  }

  /**
   * Toggle the visibility of an annotation layer.
   *
   * @param layerId - The layer ID
   * @param visible - Whether the layer should be visible
   */
  async setLayerVisible(layerId: string, visible: boolean): Promise<void> {
    const layer = this._layers.get(layerId);
    if (layer) {
      this._layers.set(layerId, { ...layer, visible });
    }
  }

  /**
   * Delete an annotation layer.
   * This removes the layer from the in-memory registry but does not
   * delete annotations belonging to the layer.
   *
   * @param layerId - The layer ID to delete
   */
  async deleteLayer(layerId: string): Promise<void> {
    this._layers.delete(layerId);
  }
}
