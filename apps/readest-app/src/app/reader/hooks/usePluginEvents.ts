import { useEffect } from 'react';
import { eventDispatcher } from '@/utils/event';

/**
 * Hook that forwards Readest events to the plugin system.
 * Listens for reader-level events and dispatches them to plugin handlers.
 *
 * @param bookKey - The current book key to scope events to
 */
export function usePluginEvents(bookKey: string) {
  useEffect(() => {
    // Forward book-level events to plugin BookAPI handlers
    // This is a placeholder — the actual forwarding will be wired
    // when the ReadestBookDataProvider emits events
    const handleBookOpen = (_event: CustomEvent) => {
      // TODO: forward to plugin book API handlers
    };

    eventDispatcher.on('book-opened', handleBookOpen);
    return () => {
      eventDispatcher.off('book-opened', handleBookOpen);
    };
  }, [bookKey]);
}
