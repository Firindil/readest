/**
 * @module plugins/providers/ReadestBookDataProvider
 * Implements the SDK's BookDataProvider interface by reading from Readest's
 * Zustand stores (bookDataStore and readerStore).
 *
 * This provider is instantiated per-request with a snapshot of the current
 * book key, so it does not directly call Zustand hooks. Instead, it receives
 * store accessor functions via dependency injection.
 */

import type {
  Book as SDKBook,
  BookMetadata as SDKBookMetadata,
  Chapter as SDKChapter,
  ChapterSummary as SDKChapterSummary,
  TextSelection as SDKTextSelection,
} from '@readest/plugin-sdk';
import type { BookDataProvider } from '@readest/plugin-sdk';

import type { Book as ReadestBook, BookConfig } from '@/types/book';
import type { BookDoc, SectionItem, TOCItem } from '@/libs/document';
import type { TextSelection as ReadestTextSelection } from '@/utils/sel';
import type { FoliateView } from '@/types/view';
import type { BookProgress } from '@/types/book';

import {
  mapReadestBookToSDK,
  mapReadestMetadataToSDK,
  mapSectionToSDKChapter,
  mapTOCToChapterSummaries,
  mapReadestSelectionToSDK,
  flattenTOC,
} from '../typeMappers';

// ---------------------------------------------------------------------------
// Dependencies — injected rather than importing hooks directly
// ---------------------------------------------------------------------------

/**
 * Store accessor interface for reading Readest book and reader state.
 * These match the shapes of useBookDataStore and useReaderStore but can
 * be provided as plain functions extracted via getState().
 */
export interface ReadestBookStoreAccessors {
  /** Get the BookData for a given bookKey (which may include a view suffix) */
  getBookData: (key: string) => {
    book: ReadestBook | null;
    config: BookConfig | null;
    bookDoc: BookDoc | null;
  } | null;

  /** Get the current reader progress for a view key */
  getProgress: (key: string) => BookProgress | null;

  /** Get the FoliateView for a view key */
  getView: (key: string) => FoliateView | null;

  /** Get the current text selection, if any */
  getCurrentSelection: () => ReadestTextSelection | null;
}

/**
 * Implements the SDK's BookDataProvider interface, bridging Readest's
 * Zustand stores to the plugin SDK's data access pattern.
 *
 * All methods read from the stores at call time (not cached), so the
 * provider always returns fresh data.
 */
export class ReadestBookDataProvider implements BookDataProvider {
  private readonly _bookKey: string;
  private readonly _accessors: ReadestBookStoreAccessors;

  /**
   * Create a new ReadestBookDataProvider.
   *
   * @param bookKey - The Readest book key (e.g., "abc123-1") identifying the
   *   current book and view
   * @param accessors - Store accessor functions for reading state
   */
  constructor(bookKey: string, accessors: ReadestBookStoreAccessors) {
    this._bookKey = bookKey;
    this._accessors = accessors;
  }

  /**
   * Get the currently open book, or null if no book is loaded for this key.
   */
  async getCurrentBook(): Promise<SDKBook | null> {
    const data = this._accessors.getBookData(this._bookKey);
    if (!data?.book) return null;
    return mapReadestBookToSDK(data.book);
  }

  /**
   * Get the currently visible chapter based on the reader's progress state.
   * Returns null if progress or the book document is unavailable.
   */
  async getCurrentChapter(): Promise<SDKChapter | null> {
    const progress = this._accessors.getProgress(this._bookKey);
    if (!progress) return null;

    const data = this._accessors.getBookData(this._bookKey);
    if (!data?.bookDoc?.sections) return null;

    const sectionIndex = progress.sectionId;
    if (sectionIndex < 0 || sectionIndex >= data.bookDoc.sections.length) return null;

    const section = data.bookDoc.sections[sectionIndex];
    if (!section) return null;

    return this._loadChapter(sectionIndex, section, data.bookDoc);
  }

  /**
   * Get a chapter by its zero-based index.
   *
   * @param index - Zero-based chapter index
   * @throws Error if the index is out of range or the book is not loaded
   */
  async getChapter(index: number): Promise<SDKChapter> {
    const data = this._accessors.getBookData(this._bookKey);
    if (!data?.bookDoc?.sections) {
      throw new Error('Book document not available');
    }

    const sections = data.bookDoc.sections;
    if (index < 0 || index >= sections.length) {
      throw new Error(`Chapter index ${index} out of range (0-${sections.length - 1})`);
    }

    const section = sections[index];
    if (!section) {
      throw new Error(`Section at index ${index} is undefined`);
    }

    return this._loadChapter(index, section, data.bookDoc);
  }

  /**
   * Get the total number of chapters (sections) in the current book.
   */
  async getChapterCount(): Promise<number> {
    const data = this._accessors.getBookData(this._bookKey);
    return data?.bookDoc?.sections?.length ?? 0;
  }

  /**
   * Get summary information for all chapters.
   * Uses the TOC if available, falls back to section data.
   */
  async getAllChapters(): Promise<SDKChapterSummary[]> {
    const data = this._accessors.getBookData(this._bookKey);
    if (!data?.bookDoc) return [];

    const toc = data.bookDoc.toc;
    if (toc && toc.length > 0) {
      return mapTOCToChapterSummaries(flattenTOC(toc));
    }

    // Fallback: generate summaries from sections
    const sections = data.bookDoc.sections ?? [];
    return sections.map((section, index) => ({
      index,
      title: section.id ?? `Section ${index + 1}`,
      href: section.href ?? '',
      wordCount: 0,
    }));
  }

  /**
   * Get the raw HTML content of a chapter.
   *
   * @param chapterIndex - Zero-based chapter index
   */
  async getChapterHTML(chapterIndex: number): Promise<string> {
    const chapter = await this.getChapter(chapterIndex);
    return chapter.html;
  }

  /**
   * Get the plain text content of a chapter (HTML stripped).
   *
   * @param chapterIndex - Zero-based chapter index
   */
  async getChapterText(chapterIndex: number): Promise<string> {
    const chapter = await this.getChapter(chapterIndex);
    return chapter.text;
  }

  /**
   * Get the current text selection, or null if nothing is selected.
   */
  async getSelectedText(): Promise<SDKTextSelection | null> {
    const selection = this._accessors.getCurrentSelection();
    if (!selection) return null;
    return mapReadestSelectionToSDK(selection);
  }

  /**
   * Get the metadata of the current book.
   * Falls back to basic metadata from the Book object if BookDoc metadata
   * is not available.
   */
  async getMetadata(): Promise<SDKBookMetadata> {
    const data = this._accessors.getBookData(this._bookKey);
    if (data?.bookDoc?.metadata) {
      return mapReadestMetadataToSDK(data.bookDoc.metadata);
    }

    // Fallback: construct from the Book object
    return {
      title: data?.book?.title ?? 'Unknown',
      author: data?.book?.author ?? 'Unknown',
      language: 'en',
    };
  }

  /**
   * Replace the entire HTML content of a chapter.
   * Dispatches the new content to the FoliateView's renderer.
   *
   * @param chapterIndex - Zero-based chapter index
   * @param html - The new HTML content
   */
  async transformChapterHTML(chapterIndex: number, html: string): Promise<void> {
    const view = this._accessors.getView(this._bookKey);
    if (!view) {
      throw new Error('No active view available for chapter transformation');
    }

    // Get the renderer contents to find the matching section
    const contents = view.renderer.getContents();
    const targetContent = contents.find((c) => c.index === chapterIndex);
    if (!targetContent) {
      throw new Error(`Chapter ${chapterIndex} is not currently rendered`);
    }

    // Replace the body content of the section document
    const doc = targetContent.doc;
    doc.body.innerHTML = html;
  }

  /**
   * Replace the HTML content of a single paragraph in a chapter.
   *
   * @param chapterIndex - Zero-based chapter index
   * @param paragraphIndex - Zero-based paragraph index
   * @param html - The new HTML content for the paragraph
   */
  async transformParagraph(
    chapterIndex: number,
    paragraphIndex: number,
    html: string,
  ): Promise<void> {
    const view = this._accessors.getView(this._bookKey);
    if (!view) {
      throw new Error('No active view available for paragraph transformation');
    }

    const contents = view.renderer.getContents();
    const targetContent = contents.find((c) => c.index === chapterIndex);
    if (!targetContent) {
      throw new Error(`Chapter ${chapterIndex} is not currently rendered`);
    }

    const doc = targetContent.doc;
    const paragraphs = doc.querySelectorAll('p, div.paragraph, [data-paragraph]');

    if (paragraphIndex < 0 || paragraphIndex >= paragraphs.length) {
      throw new Error(
        `Paragraph index ${paragraphIndex} out of range (0-${paragraphs.length - 1})`,
      );
    }

    const paragraph = paragraphs[paragraphIndex];
    if (paragraph) {
      paragraph.innerHTML = html;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Load a chapter from a section by calling createDocument() and mapping
   * the resulting DOM to an SDK Chapter.
   */
  private async _loadChapter(
    index: number,
    section: SectionItem,
    bookDoc: BookDoc,
  ): Promise<SDKChapter> {
    const doc = await section.createDocument();
    const title = this._findTitleForSection(index, bookDoc);
    return mapSectionToSDKChapter(index, section, doc, title);
  }

  /**
   * Find the TOC title for a given section index.
   * Falls back to a generic label if no matching TOC entry is found.
   */
  private _findTitleForSection(sectionIndex: number, bookDoc: BookDoc): string {
    if (!bookDoc.toc) return `Section ${sectionIndex + 1}`;

    const flatToc = flattenTOC(bookDoc.toc);
    const item = flatToc.find((t: TOCItem) => t.id === sectionIndex);
    return item?.label ?? `Section ${sectionIndex + 1}`;
  }
}
