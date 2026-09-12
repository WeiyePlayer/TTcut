import { useEffect, useRef } from 'react';
import type { Language } from './i18n';

export function UpdatePrompt({ version, downloaded, language, busy, onLater, onDownload, onSkip, onRestart }: {
  version: string;
  downloaded: boolean;
  language: Language;
  busy: boolean;
  onLater(): void;
  onDownload(): void;
  onSkip(): void;
  onRestart(): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const zh = language === 'zh-CN';
  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    return () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, []);

  return (
    <div className="modal-backdrop">
      <div ref={dialogRef} className="modal update-modal" role="dialog" aria-modal="true" aria-labelledby="update-title" aria-describedby="update-description" tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) { event.preventDefault(); onLater(); }
          if (event.key !== 'Tab') return;
          const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
          const first = buttons[0];
          const last = buttons.at(-1);
          if (!first || !last) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
            event.preventDefault(); last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first.focus();
          }
        }}>
        <h2 id="update-title">{downloaded ? (zh ? '更新已下载' : 'Update downloaded') : (zh ? '发现新版本' : 'New version available')}</h2>
        <p id="update-description">{downloaded
          ? (zh ? `TTcut ${version} 已下载完成，重启后即可安装。你也可以稍后从设置中重启安装。` : `TTcut ${version} is ready to install. Restart now, or restart from Settings later.`)
          : (zh ? `发现 TTcut ${version}。是否下载更新？跳过后将不再自动提醒此版本，仍可在设置中手动检查更新。` : `TTcut ${version} is available. Download the update? Skipping stops automatic reminders for this version. You can still check for it in Settings.`)}</p>
        <div>
          {!downloaded && <button className="secondary" disabled={busy} onClick={onSkip}>{zh ? '跳过此版本' : 'Skip this version'}</button>}
          <button className="secondary" disabled={busy} onClick={onLater}>{downloaded ? (zh ? '稍后重启' : 'Restart later') : (zh ? '稍后提醒' : 'Remind me later')}</button>
          <button className="primary" disabled={busy} onClick={downloaded ? onRestart : onDownload}>{downloaded ? (zh ? '立即重启' : 'Restart now') : (zh ? '立即更新' : 'Update now')}</button>
        </div>
      </div>
    </div>
  );
}
