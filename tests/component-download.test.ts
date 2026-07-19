import { describe, expect, it, vi } from 'vitest';
import { isTransientDownloadError, withDownloadRetries } from '../src/main/component-download';

describe('component download retries', () => {
  it('retries transient connection failures and preserves the attempt boundary', async () => {
    const work = vi.fn(async (attempt: number) => {
      if (attempt < 3) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      return 'complete';
    });
    const retries: number[] = [];

    await expect(withDownloadRetries(work, new AbortController().signal, {
      retryDelaysMs: [0, 0, 0],
      onRetry: (_error, failedAttempt) => { retries.push(failedAttempt); },
    })).resolves.toBe('complete');
    expect(work).toHaveBeenCalledTimes(3);
    expect(retries).toEqual([1, 2]);
  });

  it('does not retry integrity or permanent HTTP failures', async () => {
    const work = vi.fn(async () => { throw new Error('COMPONENT_DOWNLOAD_HASH_MISMATCH'); });
    await expect(withDownloadRetries(work, new AbortController().signal, { retryDelaysMs: [0, 0] }))
      .rejects.toThrow('COMPONENT_DOWNLOAD_HASH_MISMATCH');
    expect(work).toHaveBeenCalledTimes(1);
    expect(isTransientDownloadError(new Error('COMPONENT_DOWNLOAD_HTTP_404'))).toBe(false);
  });

  it('reports a stable error after all transient retries are exhausted', async () => {
    const work = vi.fn(async () => { throw new Error('connect ETIMEDOUT'); });
    await expect(withDownloadRetries(work, new AbortController().signal, { retryDelaysMs: [0, 0] }))
      .rejects.toThrow('COMPONENT_DOWNLOAD_RETRY_EXHAUSTED');
    expect(work).toHaveBeenCalledTimes(3);
    expect(isTransientDownloadError(new Error('COMPONENT_CURL_STALLED'))).toBe(true);
  });

  it('stops retrying immediately after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const work = vi.fn();
    await expect(withDownloadRetries(work, controller.signal, { retryDelaysMs: [0] })).rejects.toMatchObject({ name: 'AbortError' });
    expect(work).not.toHaveBeenCalled();
  });
});
