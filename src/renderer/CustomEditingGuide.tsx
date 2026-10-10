import { useId, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Language, Messages } from './i18n';
import chineseScreenshot from './assets/custom-guide-zh.png';
import englishScreenshot from './assets/custom-guide-en.png';

// Coordinates are measured against the reproducible Electron workspace capture.
const topics = [
  { key: 'selection', x: 18, y: 10 },
  { key: 'preview', x: 90, y: 6 },
  { key: 'boundaries', x: 32.8, y: 76 },
  { key: 'tools', x: 26.8, y: 90.5 },
  { key: 'zoom', x: 34.35, y: 90.5 },
  { key: 'scoreboard', x: 54.5, y: 8.6 },
  { key: 'modes', x: 41.9, y: 90.5 },
  { key: 'history', x: 51.4, y: 90.5 },
  { key: 'export', x: 93.9, y: 90.5 },
] as const;

export function CustomEditingGuide({ copy, language, platform, onClose, returnFocus }: {
  copy: Messages['customGuide'];
  language: Language;
  platform: string;
  onClose(): void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const modifier = platform === 'darwin' ? '⌘' : 'Ctrl';
  const shortcuts = [
    ['Space', copy.shortcuts.play, copy.shortcuts.page],
    ['A / D', copy.shortcuts.boundaries, copy.shortcuts.currentClip],
    ['A', copy.shortcuts.add, copy.shortcuts.addMode],
    ['Escape', copy.shortcuts.exit, copy.shortcuts.toolOrGuide],
    [`${modifier} + ${copy.shortcuts.wheel}`, copy.shortcuts.zoom, copy.shortcuts.timeline],
    [platform === 'darwin' ? '⌘Z' : 'Ctrl+Z', copy.shortcuts.undo, copy.shortcuts.outsideInput],
    [platform === 'darwin' ? '⌘⇧Z' : 'Ctrl+Y / Ctrl+Shift+Z', copy.shortcuts.redo, copy.shortcuts.outsideInput],
    ['← / →', copy.shortcuts.frame, copy.shortcuts.playheadOrHandle],
    ['Shift + ← / →', copy.shortcuts.second, copy.shortcuts.playheadOrHandle],
    ['Home / End', copy.shortcuts.ends, copy.shortcuts.playhead],
    ['← ↑ ↓ →', copy.shortcuts.moveScoreboard, copy.shortcuts.scoreboard],
    ['Shift + ← ↑ ↓ →', copy.shortcuts.moveScoreboardMore, copy.shortcuts.scoreboard],
    ['Enter / Escape', copy.shortcuts.commitCancel, copy.shortcuts.scoreInput],
    ['Enter', copy.shortcuts.activate, copy.shortcuts.rowOrButton],
  ];

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      returnFocus.current?.focus();
    };
  }, [returnFocus]);

  const locate = (key: typeof topics[number]['key']) => {
    const heading = dialogRef.current?.querySelector<HTMLElement>(`[data-guide-topic="${key}"]`);
    heading?.scrollIntoView({ block: 'start', behavior: 'auto' });
    heading?.focus({ preventScroll: true });
  };

  return (
    <dialog ref={dialogRef} className="custom-editing-guide" aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
      }}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const first = controls[0]; const last = controls.at(-1);
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !controls.includes(active as HTMLButtonElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (active === last || !controls.includes(active as HTMLButtonElement))) {
          event.preventDefault(); first?.focus();
        }
      }}>
      <header className="custom-guide-header">
        <div><span className="custom-guide-eyebrow">TTcut · {copy.eyebrow}</span><h2 id={`${id}-title`}>{copy.title}</h2></div>
        <button ref={closeRef} type="button" className="custom-guide-close" aria-label={copy.close} onClick={onClose}>×</button>
      </header>
      <div className="custom-guide-body">
        <p id={`${id}-intro`} className="custom-guide-intro">{copy.intro}</p>
        <figure className="custom-guide-figure">
          <img src={language === 'en' ? englishScreenshot : chineseScreenshot} alt={copy.imageAlt} width="2220" height="1094" />
          {topics.map((topic, index) => <button key={topic.key} type="button" className="custom-guide-pin" style={{ left: `${topic.x}%`, top: `${topic.y}%` }} aria-label={`${index + 1}. ${copy.sections[topic.key].title}`} title={copy.sections[topic.key].title} onClick={() => locate(topic.key)}>{index + 1}</button>)}
        </figure>
        <div className="custom-guide-sections">
          {topics.map((topic, index) => <section key={topic.key} className="custom-guide-topic">
            <h3 id={`${id}-${topic.key}`} data-guide-topic={topic.key} tabIndex={-1}><span aria-hidden="true">{index + 1}</span>{copy.sections[topic.key].title}</h3>
            <p>{copy.sections[topic.key].description}</p>
          </section>)}
        </div>
        <section className="custom-guide-shortcuts" aria-labelledby={`${id}-shortcuts`}>
          <h3 id={`${id}-shortcuts`}>{copy.shortcutsTitle}<span>{platform === 'darwin' ? 'macOS' : 'Windows'}</span></h3>
          <p>{copy.shortcutsNote}</p>
          <table><thead><tr><th>{copy.keyColumn}</th><th>{copy.actionColumn}</th><th>{copy.contextColumn}</th></tr></thead>
            <tbody>{shortcuts.map(([keys, action, context]) => <tr key={`${keys}-${context}`}><td><kbd>{keys}</kbd></td><td>{action}</td><td>{context}</td></tr>)}</tbody>
          </table>
        </section>
      </div>
      <footer className="custom-guide-footer"><span>{copy.pausedNote}</span><button type="button" className="primary" onClick={onClose}>{copy.done}</button></footer>
    </dialog>
  );
}
