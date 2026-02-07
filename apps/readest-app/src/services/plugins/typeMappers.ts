/**
 * @module plugins/typeMappers
 * Data conversion utilities between Readest internal types and SDK types.
 *
 * Readest uses CFI strings for locations and has different annotation type
 * naming conventions than the SDK. These mappers handle the bidirectional
 * conversion so that provider implementations can work with SDK types
 * while the underlying stores use Readest types.
 */

import type {
  Book as SDKBook,
  BookMetadata as SDKBookMetadata,
  Annotation as SDKAnnotation,
  NewAnnotation as SDKNewAnnotation,
  TextSelection as SDKTextSelection,
  Chapter as SDKChapter,
  ChapterSummary as SDKChapterSummary,
} from '@readest/plugin-sdk';

import type { Book as ReadestBook, BookNote, BookNoteType } from '@/types/book';
import type { TextSelection as ReadestTextSelection } from '@/utils/sel';
import type { BookMetadata as ReadestBookMetadata, TOCItem, SectionItem } from '@/libs/document';
import { formatTitle, formatAuthors, formatPublisher, formatDescription, getPrimaryLanguage } from '@/utils/book';
import type { LanguageMap, Contributor } from '@/utils/book';

// ---------------------------------------------------------------------------
// Annotation type mapping
// ---------------------------------------------------------------------------

/**
 * Map Readest BookNote.type to SDK Annotation.type.
 * Readest has 'bookmark' | 'annotation' | 'excerpt';
 * SDK has 'footnote' | 'highlight' | 'comment' | 'sidebar'.
 *
 * @param readestType - The Readest BookNote type
 * @returns The corresponding SDK Annotation type
 */
export function mapReadestNoteTypeToSDK(readestType: BookNoteType): SDKAnnotation['type'] {
  switch (readestType) {
    case 'bookmark':
      return 'sidebar';
    case 'annotation':
      return 'highlight';
    case 'excerpt':
      return 'comment';
    default:
      return 'highlight';
  }
}

/**
 * Map SDK Annotation.type back to Readest BookNote.type.
 *
 * @param sdkType - The SDK Annotation type
 * @returns The corresponding Readest BookNote type
 */
export function mapSDKTypeToReadestNoteType(sdkType: SDKAnnotation['type']): BookNoteType {
  switch (sdkType) {
    case 'sidebar':
      return 'bookmark';
    case 'highlight':
    case 'footnote':
      return 'annotation';
    case 'comment':
      return 'excerpt';
    default:
      return 'annotation';
  }
}

// ---------------------------------------------------------------------------
// CFI / Section index helpers
// ---------------------------------------------------------------------------

/**
 * Extract a section index from a CFI string.
 * CFI strings typically contain `/6/N!` where N encodes the section index.
 * Falls back to 0 if extraction fails.
 *
 * @param cfi - An EPUB CFI string
 * @returns The extracted section index
 */
export function extractSectionIndexFromCFI(cfi: string): number {
  if (!cfi) return 0;
  // EPUBcfi pattern: epubcfi(/6/<step>!/...) where step = (sectionIndex+1)*2
  const match = cfi.match(/\/6\/(\d+)/);
  if (match?.[1]) {
    const step = parseInt(match[1], 10);
    // Steps are 2-based: section 0 = step 2, section 1 = step 4, etc.
    return Math.max(0, Math.floor(step / 2) - 1);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Book mapping
// ---------------------------------------------------------------------------

/**
 * Convert a Readest Book to an SDK Book.
 *
 * @param book - The Readest Book object
 * @returns The corresponding SDK Book
 */
export function mapReadestBookToSDK(book: ReadestBook): SDKBook {
  const metadata = book.metadata;
  const language = metadata?.language;
  const primaryLanguage = language ? getPrimaryLanguage(language) : undefined;

  return {
    id: book.hash,
    title: book.title,
    author: book.author,
    filePath: book.filePath ?? '',
    format: book.format.toLowerCase() as SDKBook['format'],
    metadata: {
      title: book.title,
      author: book.author,
      language: primaryLanguage ?? 'en',
      publisher: metadata?.publisher
        ? formatPublisher(metadata.publisher as string | LanguageMap)
        : undefined,
      date: metadata?.published,
      description: metadata?.description
        ? formatDescription(metadata.description as string | LanguageMap)
        : undefined,
      isbn: extractISBN(metadata),
      subjects: extractSubjects(metadata),
      cover: book.coverImageUrl ?? metadata?.coverImageUrl ?? metadata?.coverImageBlobUrl,
    },
  };
}

/**
 * Extract an ISBN from Readest BookMetadata.
 *
 * @param metadata - Readest BookMetadata, possibly undefined
 * @returns The ISBN string or undefined
 */
function extractISBN(metadata: ReadestBookMetadata | undefined): string | undefined {
  if (!metadata) return undefined;
  const identifier = metadata.identifier;
  if (typeof identifier === 'string' && identifier.includes('isbn')) {
    return identifier.replace(/.*isbn[:\s]*/i, '').trim();
  }
  return undefined;
}

/**
 * Extract subject tags from Readest BookMetadata.
 *
 * @param metadata - Readest BookMetadata, possibly undefined
 * @returns An array of subject strings or undefined
 */
function extractSubjects(metadata: ReadestBookMetadata | undefined): string[] | undefined {
  if (!metadata?.subject) return undefined;
  const subject = metadata.subject;
  if (typeof subject === 'string') return [subject];
  if (Array.isArray(subject)) {
    return subject.map((s) =>
      typeof s === 'string' ? s : (s as Contributor)?.name ? formatTitle((s as Contributor).name as string | LanguageMap) : '',
    ).filter(Boolean);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// BookMetadata mapping
// ---------------------------------------------------------------------------

/**
 * Convert Readest BookMetadata (from BookDoc) to SDK BookMetadata.
 *
 * @param metadata - The Readest BookMetadata from the document
 * @returns The corresponding SDK BookMetadata
 */
export function mapReadestMetadataToSDK(metadata: ReadestBookMetadata): SDKBookMetadata {
  const title = typeof metadata.title === 'string'
    ? metadata.title
    : formatTitle(metadata.title);

  const author = typeof metadata.author === 'string'
    ? metadata.author
    : formatAuthors(metadata.author);

  const language = getPrimaryLanguage(metadata.language);

  return {
    title,
    author,
    language,
    publisher: metadata.publisher
      ? formatPublisher(metadata.publisher as string | LanguageMap)
      : undefined,
    date: metadata.published,
    description: metadata.description
      ? formatDescription(metadata.description as string | LanguageMap)
      : undefined,
    isbn: extractISBN(metadata),
    subjects: extractSubjects(metadata),
    cover: metadata.coverImageUrl ?? metadata.coverImageBlobUrl,
  };
}

// ---------------------------------------------------------------------------
// Annotation / BookNote mapping
// ---------------------------------------------------------------------------

/**
 * Convert a Readest BookNote to an SDK Annotation.
 *
 * @param note - The Readest BookNote
 * @param pluginId - The plugin ID to attribute to, defaults to 'readest'
 * @returns The corresponding SDK Annotation
 */
export function mapBookNoteToSDKAnnotation(
  note: BookNote,
  pluginId: string = 'readest',
): SDKAnnotation {
  const chapterIndex = extractSectionIndexFromCFI(note.cfi);

  return {
    id: note.id,
    pluginId,
    chapterIndex,
    startOffset: 0,
    endOffset: 0,
    type: mapReadestNoteTypeToSDK(note.type),
    content: note.text ?? note.note ?? '',
    style: note.style && note.color
      ? `${note.style}:${note.color}`
      : note.style ?? note.color,
    metadata: {
      cfi: note.cfi,
      readestNoteType: note.type,
      bookHash: note.bookHash,
    },
    createdAt: new Date(note.createdAt).toISOString(),
    updatedAt: new Date(note.updatedAt).toISOString(),
  };
}

/**
 * Convert an SDK NewAnnotation to a Readest BookNote.
 * Assigns an auto-generated ID and current timestamps.
 *
 * @param annotation - The SDK NewAnnotation
 * @param bookHash - The Readest book hash to associate with
 * @param cfi - An optional CFI string. If not provided, generates a minimal one from chapterIndex
 * @returns The corresponding Readest BookNote
 */
export function mapSDKAnnotationToBookNote(
  annotation: SDKNewAnnotation,
  bookHash?: string,
  cfi?: string,
): BookNote {
  const noteType = mapSDKTypeToReadestNoteType(annotation.type);
  const now = Date.now();
  const id = `plugin-${now}-${Math.random().toString(36).substring(2, 8)}`;

  // Parse style string back to style + color if it contains ':'
  let style: BookNote['style'];
  let color: BookNote['color'];
  if (annotation.style) {
    const parts = annotation.style.split(':');
    if (parts.length === 2) {
      style = parts[0] as BookNote['style'];
      color = parts[1] as BookNote['color'];
    } else {
      style = 'highlight';
      color = annotation.style;
    }
  }

  // Derive CFI: use provided value or metadata cfi, or synthesize a minimal one
  const resolvedCFI = cfi
    ?? (annotation.metadata?.['cfi'] as string | undefined)
    ?? `epubcfi(/6/${(annotation.chapterIndex + 1) * 2}!)`;

  return {
    id,
    bookHash,
    type: noteType,
    cfi: resolvedCFI,
    text: annotation.content,
    note: '',
    style,
    color,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// TextSelection mapping
// ---------------------------------------------------------------------------

/**
 * Convert a Readest TextSelection to an SDK TextSelection.
 *
 * @param selection - The Readest TextSelection
 * @returns The corresponding SDK TextSelection
 */
export function mapReadestSelectionToSDK(selection: ReadestTextSelection): SDKTextSelection {
  return {
    text: selection.text,
    chapterIndex: selection.index,
    startOffset: 0,
    endOffset: selection.text.length,
    paragraphIndex: undefined,
    surroundingContext: undefined,
  };
}

// ---------------------------------------------------------------------------
// Chapter / TOC mapping
// ---------------------------------------------------------------------------

/**
 * Convert a section document to an SDK Chapter.
 *
 * @param index - The zero-based section index
 * @param section - The SectionItem from BookDoc
 * @param doc - The resolved Document from createDocument()
 * @param title - The chapter title from TOC
 * @returns The corresponding SDK Chapter
 */
export function mapSectionToSDKChapter(
  index: number,
  section: SectionItem,
  doc: Document,
  title: string,
): SDKChapter {
  const html = doc.documentElement?.outerHTML ?? '';
  const text = doc.body?.textContent ?? '';
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return {
    index,
    title,
    href: section.href ?? '',
    html,
    text,
    wordCount,
  };
}

/**
 * Convert an array of TOCItems to SDK ChapterSummary objects.
 *
 * @param tocItems - The TOC items from BookDoc
 * @returns An array of SDK ChapterSummary objects
 */
export function mapTOCToChapterSummaries(tocItems: TOCItem[]): SDKChapterSummary[] {
  return tocItems.map((item) => ({
    index: item.id,
    title: item.label,
    href: item.href,
    wordCount: 0,
  }));
}

/**
 * Flatten a nested TOC tree into a flat array.
 *
 * @param items - TOC items, possibly with subitems
 * @returns A flat array of all TOC items
 */
export function flattenTOC(items: TOCItem[]): TOCItem[] {
  const result: TOCItem[] = [];
  for (const item of items) {
    result.push(item);
    if (item.subitems && item.subitems.length > 0) {
      result.push(...flattenTOC(item.subitems));
    }
  }
  return result;
}
