import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AnalysisResultV1, CutSelectionV1, ExportStrategy, VideoMetadata } from '../shared/contracts';
import type { AppEvent, SelectedVideo } from '../shared/api';
import { formatTimestamp } from '../domain/time';

type BatchMode = 'all' | 'highlight' | 'analyze-only';
type ItemStatus = 'pending' | 'analyzing' | 'exporting' | 'cancelled' | 'failed' | 'done';

type BatchItem = {
  id: string;
  video: SelectedVideo;
  metadata: VideoMetadata;
  mode: BatchMode;
  threshold: 3 | 5 | 7;
  status: ItemStatus;
  progress: number;
  analysisId: string | null;
  analysis: AnalysisResultV1 | null;
  outputPath: string | null;
  outputMediaUrl: string | null;
  error: string | null;
};

interface MultiTaskPageProps {
  initialVideos: SelectedVideo[];
  preRoll: 1.5 | 2.5 | 5;
  postRoll: 0.5 | 1 | 2 | 4;
  exportStrategy: ExportStrategy;
  onOpenAnalysis: (analysisId: string) => void;
}

function makeId(video: SelectedVideo): string {
  return `${video.path}:${video.size}:${Date.now()}:${Math.random()}`;
}

async function createItems(videos: SelectedVideo[]): Promise<BatchItem[]> {
  const items = await Promise.all(videos.map(async (video) => ({
    id: makeId(video), video, metadata: await window.ttcut.probeVideo(video.path),
    mode: 'all' as const, threshold: 5 as const, status: 'pending' as const,
    progress: 0, analysisId: null, analysis: null, outputPath: null, outputMediaUrl: null, error: null,
  })));
  return items;
}

function modeLabel(item: BatchItem): string {
  if (item.mode === 'all') return '所有回合';
  if (item.mode === 'highlight') return `精彩回合_${item.threshold}板`;
  return '只分析';
}

export function MultiTaskPage({ initialVideos, preRoll, postRoll, exportStrategy, onOpenAnalysis }: MultiTaskPageProps) {
  const [items, setItems] = useState<BatchItem[]>([]);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState<{ source: string; name: string } | null>(null);
  const itemsRef = useRef(items);
  const activeRef = useRef<{ taskId: string; itemId: string; phase: 'analysis' | 'export' } | null>(null);
  const runningRef = useRef(false);
  const cancelRequested = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const previousRects = useRef(new Map<string, DOMRect>());

  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { runningRef.current = running; }, [running]);

  useEffect(() => {
    let cancelled = false;
    void createItems(initialVideos).then((created) => {
      if (cancelled) return;
      itemsRef.current = created;
      setItems(created);
    });
    return () => { cancelled = true; };
  }, [initialVideos]);

  useLayoutEffect(() => {
    const nextRects = new Map<string, DOMRect>();
    rowRefs.current.forEach((element, id) => {
      const next = element.getBoundingClientRect();
      nextRects.set(id, next);
      const previous = previousRects.current.get(id);
      if (previous && previous.top !== next.top) {
        element.animate(
          [{ transform: `translateY(${previous.top - next.top}px)` }, { transform: 'translateY(0)' }],
          { duration: 240, easing: 'linear' },
        );
      }
    });
    previousRects.current = nextRects;
  }, [items]);

  const replaceItems = (updater: (current: BatchItem[]) => BatchItem[]) => {
    const next = updater(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  };

  const updateItem = (id: string, updater: (item: BatchItem) => BatchItem) => {
    replaceItems((current) => current.map((item) => item.id === id ? updater(item) : item));
  };

  const processNext = async (excludeId?: string) => {
    if (!runningRef.current) return;
    const candidate = itemsRef.current.find((item) => (
      item.id !== excludeId && ['pending', 'cancelled'].includes(item.status)
    ));
    if (!candidate) {
      setRunning(false);
      return;
    }
    cancelRequested.current = false;
    setActiveItem(candidate.id);
    try {
      if (candidate.analysisId && candidate.analysis && candidate.mode !== 'analyze-only') {
        updateItem(candidate.id, (item) => ({ ...item, status: 'exporting', progress: 70, error: null }));
        const selection: CutSelectionV1 = candidate.mode === 'all'
          ? { mode: 'all', pre_roll_seconds: preRoll, post_roll_seconds: postRoll }
          : { mode: 'highlight', highlight_threshold: candidate.threshold, pre_roll_seconds: preRoll, post_roll_seconds: postRoll };
        const taskId = await window.ttcut.startExport({
          analysis_id: candidate.analysisId, selection, destination: 'source', mode_label: modeLabel(candidate),
          export_strategy: exportStrategy,
        });
        activeRef.current = { taskId, itemId: candidate.id, phase: 'export' };
        setActiveTask(taskId);
      } else {
        updateItem(candidate.id, (item) => ({
          ...item, status: 'analyzing', progress: 0, analysisId: null, analysis: null, error: null,
        }));
        const taskId = await window.ttcut.startAnalysis({
          videoPath: candidate.video.path,
          calibrationChoice: { method: 'automatic' },
          device: 'auto',
          historyVisibility: candidate.mode === 'analyze-only' ? 'visible' : 'deferred',
        });
        activeRef.current = { taskId, itemId: candidate.id, phase: 'analysis' };
        setActiveTask(taskId);
      }
    } catch (caught) {
      updateItem(candidate.id, (item) => ({ ...item, status: 'failed', error: String(caught) }));
      setActiveItem(null);
      setActiveTask(null);
      setTimeout(() => void processNext(candidate.id), 0);
    }
  };

  useEffect(() => window.ttcut.onTaskEvent((event: AppEvent) => {
    const active = activeRef.current;
    if (!active || event.type === 'component-result') return;
    const taskId = event.type === 'export-result' ? event.data.taskId : event.type === 'progress' ? event.data.taskId : event.taskId;
    if (taskId !== active.taskId) return;
    if (event.type === 'progress') {
      const mapped = active.phase === 'analysis'
        ? (itemsRef.current.find((item) => item.id === active.itemId)?.mode === 'analyze-only' ? event.data.percent : event.data.percent * 0.7)
        : 70 + event.data.percent * 0.3;
      updateItem(active.itemId, (item) => ({ ...item, progress: Math.min(100, mapped) }));
      return;
    }
    if (event.type === 'analysis-result') {
      const current = itemsRef.current.find((item) => item.id === active.itemId);
      const finishedAtAnalysis = current?.mode === 'analyze-only' || event.data.rallies.length === 0;
      updateItem(active.itemId, (item) => ({
        ...item, analysisId: event.analysisId, analysis: event.data,
        status: finishedAtAnalysis ? 'done' : 'pending', progress: finishedAtAnalysis ? 100 : 70,
      }));
      activeRef.current = null;
      setActiveTask(null);
      setActiveItem(null);
      setTimeout(() => void processNext(), 0);
      return;
    }
    if (event.type === 'export-result') {
      updateItem(active.itemId, (item) => ({
        ...item, status: 'done', progress: 100, outputPath: event.data.outputPath, outputMediaUrl: event.data.mediaUrl, error: null,
      }));
      activeRef.current = null;
      setActiveTask(null);
      setActiveItem(null);
      setTimeout(() => void processNext(), 0);
      return;
    }
    const cancelled = event.code === 'EXPORT_CANCELLED'
      || (active.phase === 'analysis' && cancelRequested.current);
    updateItem(active.itemId, (item) => ({
      ...item,
      status: cancelled ? 'cancelled' : 'failed',
      progress: active.phase === 'export' && item.analysisId ? 70 : 0,
      analysisId: active.phase === 'analysis' ? null : item.analysisId,
      analysis: active.phase === 'analysis' ? null : item.analysis,
      error: cancelled ? null : event.code,
    }));
    if (cancelled) {
        replaceItems((current) => {
          const moved = current.find((item) => item.id === active.itemId);
          if (!moved) return current;
          return [...current.filter((item) => item.id !== active.itemId), moved];
      });
    }
    activeRef.current = null;
    setActiveTask(null);
    setActiveItem(null);
    setTimeout(() => void processNext(cancelled ? active.itemId : undefined), 0);
  }), [postRoll, preRoll]);

  const addVideos = async (videos: SelectedVideo[]) => {
    const existing = new Set(itemsRef.current.map((item) => item.video.path.toLowerCase()));
    const unique = videos.filter((video) => !existing.has(video.path.toLowerCase()));
    if (!unique.length) return;
    const added = await createItems(unique);
    replaceItems((current) => {
      const currentPaths = new Set(current.map((item) => item.video.path.toLowerCase()));
      return [...current, ...added.filter((item) => !currentPaths.has(item.video.path.toLowerCase()))];
    });
  };

  const chooseMore = async () => addVideos(await window.ttcut.selectVideos());
  const start = () => {
    if (runningRef.current) return;
    replaceItems((current) => current.map((item) => item.status === 'failed'
      ? { ...item, status: 'pending', error: null }
      : item));
    setRunning(true);
    runningRef.current = true;
    void processNext();
  };
  const cancel = async () => {
    if (!activeTask) return;
    cancelRequested.current = true;
    await window.ttcut.cancelTask(activeTask);
  };
  const remove = async (item: BatchItem) => {
    if (item.id === activeItem) return;
    if (item.analysisId) await window.ttcut.deleteAnalysis(item.analysisId);
    replaceItems((current) => current.filter((value) => value.id !== item.id));
  };

  const ordered = [...items].sort((left, right) => Number(right.status === 'done') - Number(left.status === 'done'));

  return (
    <section
      className="page multi-task-page"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const files = [...event.dataTransfer.files].filter((file) => file.name.toLowerCase().endsWith('.mp4'));
        void Promise.all(files.map((file) => window.ttcut.acceptDroppedVideo(window.ttcut.pathForDroppedFile(file))))
          .then(addVideos);
      }}
    >
      <div className="multi-header">
        <h1>多任务剪辑</h1>
        <button className="secondary" type="button" onClick={() => void chooseMore()}>＋ 添加视频</button>
      </div>
      <div className="batch-list">
        {ordered.map((item) => {
          const active = item.id === activeItem;
          return (
            <article
              className={`batch-row card ${item.status}`}
              key={item.id}
              ref={(element) => { if (element) rowRefs.current.set(item.id, element); else rowRefs.current.delete(item.id); }}
            >
              <button
                className={`batch-cover ${active ? 'processing' : ''}`}
                type="button"
                aria-label={active ? `取消 ${item.video.name}` : `预览 ${item.video.name}`}
                onClick={() => active ? void cancel() : setPreview({ source: item.video.mediaUrl, name: item.video.name })}
              >
                <video src={item.video.mediaUrl} preload="metadata" muted playsInline />
                {active && <span className="batch-progress"><b>{Math.round(item.progress)}%</b><i style={{ width: `${item.progress}%` }} /></span>}
                {active && <span className="batch-cancel">取消</span>}
              </button>
              <div className="batch-info"><strong title={item.video.name}>{item.video.name}</strong><span>{formatTimestamp(item.metadata.duration_seconds)} · {item.metadata.width} × {item.metadata.height} · {item.metadata.fps.toFixed(3)} fps</span>{item.error && <small>{item.error}</small>}</div>
              {item.status === 'done' ? (
                <div className="batch-actions">
                  <button className="secondary" onClick={() => item.outputMediaUrl ? setPreview({ source: item.outputMediaUrl, name: item.video.name }) : item.analysisId && onOpenAnalysis(item.analysisId)}>{item.outputPath ? '预览输出' : '查看分析'}</button>
                  <button className="secondary" onClick={() => void window.ttcut.revealOutput(item.outputPath ?? item.video.path)}>打开文件夹</button>
                </div>
              ) : (
                <>
                  <div className="batch-mode">
                    <div className="batch-mode-options" role="group" aria-label={`${item.video.name} 的剪辑模式`}>
                      {([
                        ['all', '所有回合'],
                        ['highlight', '精彩回合'],
                        ['analyze-only', '只分析'],
                      ] as const).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          className={item.mode === mode ? 'selected' : ''}
                          aria-pressed={item.mode === mode}
                          disabled={active}
                          onClick={() => updateItem(item.id, (value) => ({ ...value, mode }))}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {item.mode === 'highlight' && <div className="segmented compact">{([3, 5, 7] as const).map((value) => <button key={value} className={item.threshold === value ? 'selected' : ''} disabled={active} onClick={() => updateItem(item.id, (current) => ({ ...current, threshold: value }))}>{value}板</button>)}</div>}
                  </div>
                  <button className="batch-remove" type="button" aria-label={`删除 ${item.video.name}`} disabled={active} onClick={() => void remove(item)}>×</button>
                </>
              )}
            </article>
          );
        })}
      </div>
      <button className="batch-start primary" type="button" disabled={running || !items.some((item) => item.status !== 'done')} onClick={start}>{running ? '正在串行处理' : '开始分析剪辑'}</button>
      {preview && <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}><div className="modal batch-preview"><div><h2>{preview.name}</h2><button className="preview-close" onClick={() => setPreview(null)}>×</button></div><video src={preview.source} controls autoPlay /></div></div>}
    </section>
  );
}
