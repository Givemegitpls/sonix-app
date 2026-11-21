// Writes raw bytes to a file on the app's own storage. Used for the one body
// that cannot stream over the Bluetooth transport (the library index).

import * as FileSystem from 'expo-file-system/legacy';
import { bytesToBase64 } from '../cryptoUtils';

export async function writeBytesToFile(fileUri: string, bytes: Uint8Array): Promise<void> {
  await FileSystem.writeAsStringAsync(fileUri, bytesToBase64(bytes), { encoding: FileSystem.EncodingType.Base64 });
}
