import React from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { usePalette } from '../PaletteProvider';
import { RailLetter } from '../library/alphabetIndex';
import { AppText } from './AppText';
import { useI18n } from '../../i18n';

export interface AlphabetRailProps {
  letters: RailLetter[];
  top: number;
  bottom: number;
  onSelect: (letter: RailLetter) => void;
}

const RAIL_RIGHT = 2;
const LETTER_WIDTH = 24;
const LETTER_HEIGHT = 18;
const MIN_LETTER_HEIGHT = 8;
const LETTER_HIT_SLOP = { left: 8, right: 2 };

export function AlphabetRail({ letters, top, bottom, onSelect }: AlphabetRailProps) {
  const { t } = useI18n();
  const palette = usePalette();
  const { height } = useWindowDimensions();
  if (!letters.length) return null;
  // A library with many scripts has dozens of sections; shrink the rows so the whole rail fits.
  const available = Math.max(0, height - top - bottom);
  const rowHeight = Math.max(MIN_LETTER_HEIGHT, Math.min(LETTER_HEIGHT, Math.floor(available / letters.length)));
  const fontSize = Math.max(MIN_LETTER_HEIGHT, Math.min(11, rowHeight - 2));
  return (
    <View pointerEvents="box-none" style={[styles.rail, { top, bottom }]}>
      {letters.map(({ letter, itemIndex, position }) => (
        <Pressable
          key={letter}
          accessibilityRole="button"
          accessibilityLabel={t('Jump to {letter}', { letter })}
          hitSlop={LETTER_HIT_SLOP}
          onPress={() => onSelect({ letter, itemIndex, position })}
          style={({ pressed }) => [
            styles.letter,
            { height: rowHeight, borderRadius: rowHeight / 2 },
            pressed && { backgroundColor: palette.surfaceRaised },
          ]}
        >
          <AppText variant="micro" tone="inkMuted" allowFontScaling={false} style={[styles.letterText, { fontSize, lineHeight: rowHeight }]}>
            {letter}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    position: 'absolute',
    right: RAIL_RIGHT,
    justifyContent: 'center',
  },
  letter: {
    width: LETTER_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  letterText: {
    fontWeight: '600',
  },
});
