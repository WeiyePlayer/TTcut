import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useNativePreview } from '../src/renderer/use-native-preview';
let preview: ReturnType<typeof useNativePreview>;
function Harness(){preview=useNativePreview('ttcut-media://media/test',true);return <div ref={preview.surfaceRef}/>;}
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
it('keeps displaying coalesced keyframes during continuous drag, then sends only the final exact seek',async()=>{
  vi.useFakeTimers();const command=vi.fn().mockResolvedValue(undefined),close=vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('ttcut',{nativePreviewOpen:vi.fn().mockResolvedValue(undefined),nativePreviewCommand:command,nativePreviewClose:close,onNativePreviewEvent:()=>()=>{}});
  const view=render(<Harness/>);await act(async()=>{});command.mockClear();
  act(()=>preview.seekTo(1,false,false));await act(async()=>vi.advanceTimersByTimeAsync(20));
  act(()=>preview.seekTo(2,false,false));await act(async()=>vi.advanceTimersByTimeAsync(25));
  const seeks=()=>command.mock.calls.map(([,c])=>c).filter(c=>c.type==='seek');
  expect(seeks()).toEqual([expect.objectContaining({time:2,exact:false})]);
  act(()=>preview.seekTo(3,false,false));act(()=>preview.seekTo(3.14,false,true));await act(async()=>vi.advanceTimersByTimeAsync(60));
  expect(seeks()).toHaveLength(2);expect(seeks()[1]).toMatchObject({time:3.14,exact:true});
  act(()=>preview.seekTo(4,false,false));view.unmount();await act(async()=>vi.advanceTimersByTimeAsync(60));
  expect(seeks()).toHaveLength(2);expect(close).toHaveBeenCalledOnce();
});
