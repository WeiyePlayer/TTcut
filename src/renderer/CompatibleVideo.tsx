import { useCallback, useEffect, useRef, useState, type Ref, type VideoHTMLAttributes } from 'react';

/** Keeps the same HTML video/ref while swapping only its disposable playback URL. */
export function CompatibleVideo({ ref, hdr = false, ...props }: VideoHTMLAttributes<HTMLVideoElement> & { ref?: Ref<HTMLVideoElement>; hdr?: boolean }) {
  const [proxy, setProxy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Main settles a request only with the URL, a real failure, or CANCELLED for this request's own id;
  // while it waits behind a user task or re-runs after a preemption, the original keeps playing.
  const [pending, setPending] = useState(false);
  const [sourceUnplayable, setSourceUnplayable] = useState(false);
  const task = useRef<string | null>(null);
  const generation = useRef(0);
  const attempted = useRef(false);
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
    attempted.current = true; failure.current = null;
    const current = generation.current;
    const id = crypto.randomUUID(); task.current = id; setError(null); setPending(true);
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
        if (!reason.includes('CANCELLED')) fail(`${english ? 'Preview failed' : '预览生成失败'}: ${reason.slice(0, 500)}`);
      }
    }
    finally { if (task.current === id) task.current = null; if (current === generation.current) setPending(false); }
  }
  function fail(message: string) {
    failure.current = message;
    console.warn(`[preview] ${message}`);
    if (sourceFailed.current) setError(message);
  }
  useEffect(() => {
    generation.current++; attempted.current = false; failure.current = null; sourceFailed.current = false;
    setProxy(null); setError(null); setPending(false); setSourceUnplayable(false);
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
        sourceFailed.current = true; setSourceUnplayable(true);
        if (!attempted.current) void prepare();
        else if (failure.current && !task.current) setError(failure.current);
      }} />
    {/* Only an unplayable original leaves nothing on screen, so only then say a proxy is coming. */}
    {!error && pending && sourceUnplayable && !proxy && <div className="compatibility-preview-status" role="status" style={{ pointerEvents: 'none' }}><span>{english ? 'Preparing a compatible preview…' : '正在准备兼容预览…'}</span></div>}
    {error && <div className="compatibility-preview-status" role="alert" onPointerDown={(e) => e.stopPropagation()}><span>{error}</span><button type="button" onClick={() => void prepare()}>{english ? 'Retry' : '重试'}</button></div>}
  </>;
}
