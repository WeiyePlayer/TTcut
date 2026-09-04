import { useEffect, useRef, useState, type Ref, type VideoHTMLAttributes } from 'react';

/** Keeps the same HTML video/ref while swapping only its disposable playback URL. */
export function CompatibleVideo({ ref, hdr = false, ...props }: VideoHTMLAttributes<HTMLVideoElement> & { ref?: Ref<HTMLVideoElement>; hdr?: boolean }) {
  const [proxy, setProxy] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const task = useRef<string | null>(null);
  const generation = useRef(0);
  const attempted = useRef(false);
  const mac = window.ttcut?.platform === 'darwin';
  const english = document.documentElement.lang.startsWith('en');
  async function prepare() {
    if (!mac || !props.src || !window.ttcut.preparePreview || task.current) return;
    attempted.current = true;
    const current = generation.current;
    const id = crypto.randomUUID(); task.current = id; setPercent(0); setError(null);
    const off = window.ttcut.onPreviewProgress?.((value) => { if (value.taskId === id && current === generation.current) setPercent(value.percent); });
    try { const url = await window.ttcut.preparePreview(props.src, id); if (current === generation.current) setProxy(url); }
    catch (error) {
      if (current === generation.current) {
        const reason = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
        setError(reason.includes('TASK_BUSY')
          ? (english ? 'Finish the current task, then retry preview.' : '请在当前任务完成后重试预览。')
          : reason.includes('CANCELLED')
            ? (english ? 'Preview cancelled.' : '已取消预览。')
            : `${english ? 'Preview failed' : '预览生成失败'}: ${reason}`);
      }
    }
    finally { off?.(); if (task.current === id) task.current = null; if (current === generation.current) setPercent(null); }
  }
  useEffect(() => {
    generation.current++; attempted.current = false; setProxy(null); setError(null); setPercent(null);
    if (mac && hdr) void prepare();
    return () => { generation.current++; const id = task.current; task.current = null; if (id) void window.ttcut.cancelTask(id); };
  }, [props.src, hdr]);
  return <>
    <video {...props} ref={ref} src={proxy ?? props.src} onError={(event) => { props.onError?.(event); if (!attempted.current) void prepare(); }} />
    {percent !== null && <div className="compatibility-preview-status" role="status" onPointerDown={(e) => e.stopPropagation()}>
      <span>{english ? 'Preparing preview' : '正在准备预览'} {Math.round(percent)}%</span>
      <button type="button" onClick={() => { if (task.current) void window.ttcut.cancelTask(task.current); }}>{english ? 'Cancel' : '取消'}</button>
    </div>}
    {error && <div className="compatibility-preview-status" role="alert" onPointerDown={(e) => e.stopPropagation()}><span>{error}</span><button type="button" onClick={() => void prepare()}>{english ? 'Retry' : '重试'}</button></div>}
  </>;
}
