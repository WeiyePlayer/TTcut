import { describe, expect, it } from 'vitest';
import {
  COMPONENT_SPACE_RESERVE_BYTES,
  remainingDownloadBytes,
  requiredComponentSpace,
} from '../src/main/component-space';

describe('managed component space budget', () => {
  it('reserves download, extraction, backup, and safety space', () => {
    expect(requiredComponentSpace(100, 200, 300)).toBe(600 + COMPONENT_SPACE_RESERVE_BYTES);
  });

  it('rejects unsafe numeric inputs', () => {
    expect(() => requiredComponentSpace(-1, 0, 0)).toThrow('COMPONENT_SPACE_INPUT_INVALID');
    expect(() => requiredComponentSpace(Number.MAX_VALUE, 0, 0)).toThrow('COMPONENT_SPACE_INPUT_INVALID');
  });

  it('only budgets bytes that are not already present in a resumable download', () => {
    expect(remainingDownloadBytes(1_000, 400)).toBe(600);
    expect(remainingDownloadBytes(1_000, 1_200)).toBe(0);
  });
});
