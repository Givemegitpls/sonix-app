const NON_ASCII = /[^\x00-\x7f]/;
const COMBINING_MARKS = /[̀-ͯ]/g;
const UNDECOMPOSED_LETTERS = /[ßæœøłđðþı]/g;
const LETTER_SPELLINGS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
};

// The characters the player's browse collation skips at the start of a title (utf8_collate_compare
// in compas-player), so local ordering and section letters agree with the player's lists.
export function isIgnorableLeading(code: number): boolean {
  if (code < 128) return !((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a));
  return (
    (code >= 0x2000 && code <= 0x206f) || (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xfe10 && code <= 0xfe1f) || (code >= 0xfe30 && code <= 0xfe6f) ||
    code === 0x00a0 || code === 0x00a1 || code === 0x00ab || code === 0x00bb || code === 0x00bf
  );
}

function withoutLeadingIgnorable(title: string): string {
  let start = 0;
  while (start < title.length && isIgnorableLeading(title.charCodeAt(start))) start++;
  return start ? title.slice(start) : title;
}

export const NON_LETTER_KEY = '#';
/** Symbols and scripts without letter case (CJK, Arabic, Hebrew…) share one section after Z. */
export const OTHER_SCRIPT_KEY = '…';

// Latin letters whose decomposition is not a base letter plus accents.
const LATIN_LETTERS: Record<string, string> = {
  Æ: 'A', æ: 'A', Œ: 'O', œ: 'O', ß: 'S', ẞ: 'S', Þ: 'T', þ: 'T', Ð: 'D', ð: 'D', Đ: 'D', đ: 'D',
  Ø: 'O', ø: 'O', Ł: 'L', ł: 'L', Ħ: 'H', ħ: 'H', Ŧ: 'T', ŧ: 'T', Ŀ: 'L', ŀ: 'L', ı: 'I', Ĳ: 'I', ĳ: 'I',
};

/** The section a title is filed under; sections follow the same collation as `titleSortKey`. */
export function titleLetter(title: string): string {
  let first = '';
  for (const char of title.normalize('NFD')) {
    const code = char.codePointAt(0)!;
    if (code >= 0x0300 && code <= 0x036f) continue;
    if (isIgnorableLeading(code)) continue;
    first = char;
    break;
  }
  // Digits sort before A on the player; everything that is not Latin sorts after Z.
  if (!first || /[0-9]/.test(first)) return NON_LETTER_KEY;
  if (/[a-z]/i.test(first)) return first.toUpperCase();
  if (LATIN_LETTERS[first]) return LATIN_LETTERS[first];
  const upper = first.toUpperCase();
  return upper !== first.toLowerCase() ? upper : OTHER_SCRIPT_KEY;
}

export function titleSortKey(title: string): string {
  const lower = withoutLeadingIgnorable(title).toLowerCase();
  if (!NON_ASCII.test(lower)) return lower;
  return lower
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(UNDECOMPOSED_LETTERS, (letter) => LETTER_SPELLINGS[letter]);
}

export function sortedByTitle<T>(items: readonly T[], titleOf: (item: T) => string): T[] {
  const keyed = items.map((item, index) => ({ item, index, key: titleSortKey(titleOf(item)) }));
  let ordered = true;
  for (let index = 1; ordered && index < keyed.length; index++) ordered = keyed[index - 1].key <= keyed[index].key;
  if (ordered) return items.slice();
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
  return keyed.map(({ item }) => item);
}
