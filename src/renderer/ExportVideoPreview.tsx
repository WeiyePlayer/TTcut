import { useEffect, useRef, type VideoHTMLAttributes } from 'react';
import { CompatibleVideo } from './CompatibleVideo';
import { useCompatiblePreview } from './use-compatible-preview';
import { messages } from './i18n';

/** Export files retain their format; only the disposable playback URL may change. */
export function ExportVideoPreview({ hdr = false, ...props }: VideoHTMLAttributes<HTMLVideoElement> & { hdr?: boolean }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const preview = useCompatiblePreview(video, props.src ?? '', hdr ? 'hevc' : undefined);
  const text = messages(document.documentElement.lang.startsWith('en') ? 'en' : 'zh-CN');
  useEffect(() => {
    if (preview.status === 'ready' && props.autoPlay) void Promise.resolve(video.current?.play()).catch(() => undefined);
  }, [preview.status, preview.url, props.autoPlay]);
  return <>
    {preview.status !== 'ready' && <div className="compatibility-preview-status" role={preview.status === 'failed' ? 'alert' : 'status'}>
      <span>{preview.status === 'preparing' ? text.previewPreparing : text.previewFailed}</span>
      {preview.status === 'failed' && <button type="button" onClick={preview.retry}>{text.previewRetry}</button>}
    </div>}
    <CompatibleVideo {...props} autoPlay={Boolean(props.autoPlay && preview.status === 'ready')} controls={Boolean(props.controls && preview.status === 'ready')} hdr={hdr} ref={video} src={preview.url} />
  </>;
}
