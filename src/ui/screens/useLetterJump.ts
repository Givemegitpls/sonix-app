import { useCallback, useEffect, useRef } from 'react';
import type { RemoteAction } from '../../data/types';
import type { RailLetter } from '../library/alphabetIndex';
import type { LibraryListScroll } from '../library/useLibraryListScroll';

// Negative: the target row is placed this far below the top of the list, clear of the sticky chips bar.
const STICKY_CHIPS_OFFSET = -104;

/**
 * Plays the rail's letter press. A letter whose section is loaded scrolls right
 * away; one beyond the loaded pages asks the session to read up to it and
 * scrolls after the rows arrive.
 */
export function useLetterJump(
  letters: RailLetter[],
  scroll: LibraryListScroll,
  scrollToTop: (animated?: boolean) => void,
  onAction: (action: RemoteAction) => void,
): (letter: RailLetter) => void {
  const pending = useRef<{ letter: string; position: number } | null>(null);
  const jump = useCallback((itemIndex: number) => {
    const first = letters[0]?.itemIndex ?? -1;
    // The first letter goes to the very top, so the header (and its selection bar) isn't left under the chips.
    if (first >= 0 && itemIndex <= first) {
      scrollToTop(false);
      return;
    }
    scroll.listRef.current?.scrollToIndex({ index: itemIndex, animated: false, viewOffset: STICKY_CHIPS_OFFSET });
  }, [letters, scroll.listRef, scrollToTop]);

  useEffect(() => {
    const target = pending.current;
    if (!target) return;
    const loaded = letters.find((item) => item.letter === target.letter && item.itemIndex >= 0);
    if (!loaded) return;
    pending.current = null;
    const index = loaded.itemIndex;
    // The rows around the target may not be laid out in the same frame they arrive;
    // a second pass after the list has rendered them lands on the section reliably.
    jump(index);
    const retry = setTimeout(() => jump(index), 150);
    return () => clearTimeout(retry);
  }, [jump, letters]);

  return useCallback((letter: RailLetter) => {
    if (letter.itemIndex >= 0) {
      pending.current = null;
      jump(letter.itemIndex);
      return;
    }
    if (letter.position == null) return;
    pending.current = { letter: letter.letter, position: letter.position };
    onAction({ type: 'RevealLibraryLetter', position: letter.position });
  }, [jump, onAction]);
}
