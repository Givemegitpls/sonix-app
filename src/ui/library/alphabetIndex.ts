import { NON_LETTER_KEY, OTHER_SCRIPT_KEY, titleLetter } from '../../core/titleOrder';
import { LibraryEntry } from '../../data/types';
import { LibraryItem } from './libraryItems';

export { NON_LETTER_KEY, OTHER_SCRIPT_KEY };
export const letterOfTitle = titleLetter;

export function letterOfEntry(entry: LibraryEntry): string {
  return letterOfTitle(entry.title);
}

export interface RailLetter {
  letter: string;
  /** Row index in the list; -1 while the section is not loaded yet. */
  itemIndex: number;
  /** Index of the section's first song in the player's full, ordered song list. */
  position?: number;
}

export function railLetters(items: LibraryItem[]): RailLetter[] {
  const seen = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.type === 'letter' && !seen.has(item.letter)) seen.set(item.letter, index);
  });
  // The player's order puts digits first and other scripts last, so the rail follows the list.
  return [...seen.entries()]
    .map(([letter, itemIndex]) => ({ letter, itemIndex }))
    .sort((a, b) => a.itemIndex - b.itemIndex);
}
