import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { nativeTransferError } from './nativeTransferError';
import { getMultipartTransfers, getPinSafeTransfers } from '../../modules/compas-files/src';

export interface NativeUploadProgress {
  sent: number;
  total: number;
}

export interface NativeUploadResponse {
  status: number;
  body: string;
}

const CANCEL_SETTLE_TIMEOUT_MS = 5000;

/** Streams a local file from native storage as the raw HTTP request body. */
export function uploadFileNative(
  url: string,
  fileUri: string,
  headers: Record<string, string>,
  onProgress: (progress: NativeUploadProgress) => void,
  signal?: AbortSignal,
): Promise<NativeUploadResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Upload cancelled'));
      return;
    }

    const native = getPinSafeTransfers();
    const options = { url, fileUri, headers, onProgress, signal, resolve, reject };
    if (native) uploadUsingPinSafeTransfer(native, options);
    else uploadUsingFileSystem(options);
  });
}

interface UploadOptions {
  url: string;
  fileUri: string;
  headers: Record<string, string>;
  onProgress: (progress: NativeUploadProgress) => void;
  signal?: AbortSignal;
  resolve: (response: NativeUploadResponse) => void;
  reject: (error: unknown) => void;
}

function uploadUsingPinSafeTransfer(
  native: NonNullable<ReturnType<typeof getPinSafeTransfers>>,
  { url, fileUri, headers, onProgress, signal, resolve, reject }: UploadOptions,
) {
  const taskId = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const progress = native.addListener('onUploadProgress', (event) => {
    if (event.taskId === taskId && !signal?.aborted) onProgress({ sent: event.sent, total: event.total });
  });
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    native.cancelTransfer(taskId);
    // The old path rejected within this window even if the native task never settled.
    cancelTimer = setTimeout(() => reject(new Error('Upload cancellation timed out')), CANCEL_SETTLE_TIMEOUT_MS);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  native.uploadFile(taskId, url, fileUri, headers).then(
    (result) => resolve({ status: result.status, body: result.body }),
    (error) => reject(signal?.aborted ? new Error('Upload cancelled') : nativeTransferError(error)),
  ).finally(() => {
    if (cancelTimer) clearTimeout(cancelTimer);
    progress.remove();
    signal?.removeEventListener('abort', cancel);
  });
}

function uploadUsingFileSystem({ url, fileUri, headers, onProgress, signal, resolve, reject }: UploadOptions) {
  let settled = false;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelStarted = false;
  let rejectCancellation!: (error: Error) => void;
  const cancellationPromise = new Promise<never>((_resolve, cancelReject) => { rejectCancellation = cancelReject; });
  let removeAbortListener = () => {};
  const settle = (complete: () => void) => {
    if (settled) return;
    settled = true;
    if (cancelTimer) clearTimeout(cancelTimer);
    removeAbortListener();
    complete();
  };

  let task: ReturnType<typeof FileSystem.createUploadTask>;
  try {
    task = createFileSystemUpload(url, fileUri, headers, (event) => {
      if (!settled && !signal?.aborted) onProgress({ sent: event.totalBytesSent, total: event.totalBytesExpectedToSend });
    });
  } catch (error) {
    reject(error);
    return;
  }

  const uploadPromise = (() => {
    try { return task.uploadAsync(); }
    catch (error) { return Promise.reject(error); }
  })();

  const abort = () => {
    if (cancelStarted || settled) return;
    cancelStarted = true;
    cancelTimer = setTimeout(() => rejectCancellation(new Error('Upload cancellation timed out')), CANCEL_SETTLE_TIMEOUT_MS);
    Promise.resolve().then(() => task.cancelAsync()).then(
      () => rejectCancellation(new Error('Upload cancelled')),
      (error) => rejectCancellation(error),
    );
  };
  if (signal) {
    signal.addEventListener('abort', abort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  }

  const observedUpload = uploadPromise.then(
    (result) => result,
    (error) => {
      if (signal?.aborted) return cancellationPromise;
      throw error;
    },
  );
  Promise.race([observedUpload, cancellationPromise]).then(
    (result) => settle(() => resolveFileSystemUpload(result, resolve, reject)),
    (error) => settle(() => reject(error)),
  );
}

function createFileSystemUpload(
  url: string, fileUri: string, headers: Record<string, string>,
  onProgress: Parameters<typeof FileSystem.createUploadTask>[3],
) {
  return FileSystem.createUploadTask(url, fileUri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers,
  }, onProgress);
}

function resolveFileSystemUpload(
  result: Awaited<ReturnType<ReturnType<typeof FileSystem.createUploadTask>['uploadAsync']>>,
  resolve: UploadOptions['resolve'],
  reject: UploadOptions['reject'],
) {
  if (!result) reject(new Error('Upload did not return a response'));
  else resolve({ status: result.status, body: result.body });
}

/**
 * Uploads one file as `multipart/form-data`, because the player's Transfer mode
 * answers with the firmware's own `upload.cgi`, which takes the destination in
 * a `path` field and the file in `files[]`.
 *
 * The native client is preferred (it streams with OkHttp and cancels like the
 * other transfers); the fallback is expo-file-system's own multipart task,
 * which also streams from disk.
 */
export function uploadMultipartNative(
  url: string,
  fileUri: string,
  fields: Record<string, string>,
  fieldName: string,
  fileName: string,
  onProgress: (progress: NativeUploadProgress) => void,
  signal?: AbortSignal,
): Promise<NativeUploadResponse> {
  if (signal?.aborted) return Promise.reject(new Error('Upload cancelled'));
  const native = getMultipartTransfers();
  if (native) {
    return new Promise((resolve, reject) => {
      const taskId = `multipart-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const progress = native.addListener('onUploadProgress', (event) => {
        if (event.taskId === taskId && !signal?.aborted) onProgress({ sent: event.sent, total: event.total });
      });
      const cancel = () => native.cancelTransfer(taskId);
      signal?.addEventListener('abort', cancel, { once: true });
      native.uploadMultipartFile(taskId, url, fileUri, fields, fieldName, fileName).then(
        (result) => resolve({ status: result.status, body: result.body }),
        (error) => reject(signal?.aborted ? new Error('Upload cancelled') : nativeTransferError(error)),
      ).finally(() => {
        progress.remove();
        signal?.removeEventListener('abort', cancel);
      });
    });
  }
  if (Platform.OS !== 'android') return Promise.reject(new Error('File transfer is an Android capability'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      complete();
    };
    const task = FileSystem.createUploadTask(url, fileUri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName,
      mimeType: 'application/octet-stream',
      parameters: fields,
    }, (event) => {
      if (!settled && !signal?.aborted) {
        onProgress({ sent: event.totalBytesSent, total: event.totalBytesExpectedToSend });
      }
    });
    const abort = () => {
      Promise.resolve()
        .then(() => task.cancelAsync())
        .then(() => settle(() => reject(new Error('Upload cancelled'))), () => settle(() => reject(new Error('Upload cancelled'))));
    };
    signal?.addEventListener('abort', abort, { once: true });
    task.uploadAsync().then(
      (result) => settle(() => result ? resolve({ status: result.status, body: result.body }) : reject(new Error('Upload did not return a response'))),
      (error) => settle(() => reject(signal?.aborted ? new Error('Upload cancelled') : error)),
    );
  });
}
