import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomTimeline } from '../src/renderer/CustomTimeline';
import type { CustomRallyClip } from '../src/domain/custom-clips';

const clip = (id: number, start: number, end: number): CustomRallyClip => ({
  clipId: String(id), rallyIndex: id, start, end, defaultStart: start, defaultEnd: end,
  selected: true, source: 'manual', sourceRallyId: null, bounceCount: null,
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('ResizeObserver', undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(gap = 0, currentTime = 0) {
  const onResize = vi.fn((_id: string, _edge: string, time: number) => time);
  const onPlayClip = vi.fn();
  render(<CustomTimeline clips={[clip(1, 1, 5), clip(2, 5 + gap, 9)]} duration={10} fps={30}
    currentTime={currentTime} currentEditingClipId={null} timelineLabel="Timeline" resizeStartLabel="Start" resizeEndLabel="End"
    toolMode={null} onSeek={vi.fn()} onScrubCancel={vi.fn()} onPlayClip={onPlayClip}
    onResize={onResize} onAddAt={() => false} onDeleteClip={vi.fn()} />);
  const handle = (name: string) => {
    const element = screen.getByRole('slider', { name });
    element.setPointerCapture = vi.fn();
    return element;
  };
  return { onResize, onPlayClip, handle };
}

describe('adjacent timeline handles', () => {
  it.each(['End 1', 'Start 2'])('resolves both directions regardless of hit target %s', (name) => {
    const { handle, onResize, onPlayClip } = setup();
    const target = handle(name);
    fireEvent.pointerDown(target, { clientX: 500 });
    fireEvent.pointerMove(target, { clientX: 499 });
    expect(onResize).not.toHaveBeenCalled();
    expect(document.querySelector('.resize-feedback')).toBeNull();
    fireEvent.pointerMove(target, { clientX: 480 });
    expect(onResize).toHaveBeenLastCalledWith('1', 'end', 4.8);
    // Reversing direction during the same gesture must retain the chosen clip.
    fireEvent.pointerMove(target, { clientX: 520 });
    expect(onResize).toHaveBeenLastCalledWith('1', 'end', 5.2);
    fireEvent.pointerUp(target);
    fireEvent.pointerDown(target, { clientX: 500 });
    fireEvent.pointerMove(target, { clientX: 520 });
    expect(onResize).toHaveBeenLastCalledWith('2', 'start', 5.2);
    expect(document.querySelector('.resize-feedback')).toHaveAttribute('data-clip-id', '2');
    expect(onPlayClip).not.toHaveBeenCalled();
  });

  it.each(['pointerUp', 'pointerCancel', 'lostPointerCapture'] as const)('clears pending selection on %s', (event) => {
    const { handle, onResize } = setup();
    const target = handle('Start 2');
    fireEvent.pointerDown(target, { clientX: 500 });
    fireEvent[event](target);
    fireEvent.pointerMove(target, { clientX: 480 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('keeps separated edges and keyboard resizing explicit', () => {
    const { handle, onResize } = setup(0.5);
    const target = handle('Start 2');
    fireEvent.pointerDown(target, { clientX: 550 });
    fireEvent.pointerMove(target, { clientX: 530 });
    expect(onResize).toHaveBeenLastCalledWith('2', 'start', 5.3);
    fireEvent.pointerUp(target);
    fireEvent.keyDown(handle('End 1'), { key: 'ArrowLeft', shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith('1', 'end', 4);
  });

  it('snaps pointer resizing to the playhead within eight rendered pixels', () => {
    const { handle, onResize } = setup(0.5, 5.38);
    const target = handle('Start 2');
    fireEvent.pointerDown(target, { clientX: 550 });
    fireEvent.pointerMove(target, { clientX: 539 });
    expect(onResize).toHaveBeenLastCalledWith('2', 'start', 5.38);
    fireEvent.pointerMove(target, { clientX: 528 });
    expect(onResize).toHaveBeenLastCalledWith('2', 'start', 5.28);
  });
});
