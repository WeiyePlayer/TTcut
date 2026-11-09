import { useCallback, useEffect, useRef, useState, type Ref, type VideoHTMLAttributes } from 'react';

/** Keeps the same HTML video/ref while swapping only its disposable playback URL. */
export function CompatibleVideo({ ref, hdr = false, ...props }: VideoHTMLAttributes<HTMLVideoElement> & { ref?: Ref<HTMLVideoElement>; hdr?: boolean }) {
  const [proxy, setProxy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const task = useRef<string | null>(null);
  const generation = useRef(0);
  const attempted = useRef(false);
  // A preempted (CANCELLED) or postponed (TASK_BUSY) attempt is not a failure:
  // the original keeps playing and the proxy can be prepared again later.
  const deferred = useRef(false);
  // Proxy failures stay in the log while the original still plays; the notice
  // and retry appear only once neither the original nor the proxy is playable.
  const failure = useRef<string | null>(null);
  const sourceFailed = useRef(false);
  const video = useRef<HTMLVideoElement | null>(null);
  const attach = useCallback((element: HTMLVideoElement | null) => {
    video.current = element;
    if (typeof ref === 'function') return ref(element);
    if (ref) ref.current = element;
  }, [ref]);
  const mac = window.ttcut?.platform === 'darwin';
  const english = document.documentElement.lang.startsWith('en');
  async function prepare() {
    if (!mac || !props.src || !window.ttcut.preparePreview || task.current) return;
    attempted.current = true; deferred.current = false; failure.current = null;
    const current = generation.current;
    const id = crypto.randomUUID(); task.current = id; setError(null);
    try {
      const url = await window.ttcut.preparePreview(props.src, id);
      if (current === generation.current) {
        setProxy(url);
        // A retry can return the same valid cached URL; reload clears the media error.
        if (url === proxy) video.current?.load();
      }
    }
    catch (error) {
      if (current === generation.current) {
        const reason = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
        if (reason.includes('TASK_BUSY') || reason.includes('CANCELLED')) deferred.current = true;
        else fail(`${english ? 'Preview failed' : '预览生成失败'}: ${reason.slice(0, 500)}`);
      }
    }
    finally { if (task.current === id) task.current = null; }
  }
  function fail(message: string) {
    failure.current = message;
    console.warn(`[preview] ${message}`);
    if (sourceFailed.current) setError(message);
  }
  useEffect(() => {
    generation.current++; attempted.current = false; deferred.current = false; failure.current = null; sourceFailed.current = false; setProxy(null); setError(null);
    if (mac && hdr) void prepare();
    return () => { generation.current++; const id = task.current; task.current = null; if (id) void window.ttcut.cancelTask(id); };
  }, [props.src, hdr]);
  return <>
    <video {...props} ref={attach} src={proxy ?? props.src}
      onError={(event) => {
        props.onError?.(event);
        if (!mac) return;
        if (proxy) {
          const message = english ? 'Preview playback failed. Please retry.' : '预览播放失败，请重试。';
          // An HDR original that still plays is a better fallback than a notice.
          if (!sourceFailed.current) setProxy(null);
          fail(message);
          return;
        }
        sourceFailed.current = true;
        if (!attempted.current) void prepare();
        else if (failure.current && !task.current) setError(failure.current);
      }} />
    {error && <div className="compatibility-preview-status" role="alert" onPointerDown={(e) => e.stopPropagation()}><span>{error}</span><button type="button" onClick={() => void prepare()}>{english ? 'Retry' : '重试'}</button></div>}
  </>;
}
