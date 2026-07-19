const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

function abortError(): Error {
  return Object.assign(new Error('SETUP_CANCELLED'), { name: 'AbortError' });
}

export function isTransientDownloadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (/COMPONENT_DOWNLOAD_HTTP_(?:408|425|429|5\d\d)\b/.test(message)) return true;
  if (/COMPONENT_CURL_EXIT_(?:5|6|7|18|28|35|52|55|56|92)\b/.test(message)) return true;
  if (message === 'COMPONENT_CURL_STALLED') return true;
  if (message === 'COMPONENT_DOWNLOAD_SIZE_MISMATCH') return true;
  return /(?:ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ERR_CONNECTION_|ERR_NETWORK_|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|\baborted\b)/i.test(`${code} ${message}`);
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withDownloadRetries<T>(
  work: (attempt: number) => Promise<T>,
  signal: AbortSignal,
  options: {
    retryDelaysMs?: readonly number[];
    onRetry?: (error: unknown, failedAttempt: number, maxAttempts: number) => void | Promise<void>;
  } = {},
): Promise<T> {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const maxAttempts = delays.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal.aborted) throw abortError();
    try {
      return await work(attempt);
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError();
      if (!isTransientDownloadError(error)) throw error;
      if (attempt === maxAttempts) throw new Error('COMPONENT_DOWNLOAD_RETRY_EXHAUSTED', { cause: error });
      await options.onRetry?.(error, attempt, maxAttempts);
      await waitForRetry(delays[attempt - 1] ?? 0, signal);
    }
  }
  throw new Error('COMPONENT_DOWNLOAD_RETRY_EXHAUSTED');
}
