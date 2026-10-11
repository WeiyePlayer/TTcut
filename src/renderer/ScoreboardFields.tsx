import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ScoreboardScore, ScoreboardStyle } from '../shared/contracts';

function EditableCell({ value, label, numeric = false, disabled = false, className, onChange, onEditStart }: {
  value: string; label: string; numeric?: boolean; disabled?: boolean; className: string;
  onChange(value: string): void;
  onEditStart(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cell = useRef<HTMLSpanElement>(null);
  const selectZero = useRef(false);
  useLayoutEffect(() => {
    if (selectZero.current) { cell.current?.querySelector('input')?.select(); selectZero.current = false; }
  });
  const commit = () => { setEditing(false); onChange(numeric ? String(Math.min(999, Number(draft) || 0)) : draft.trim()); };
  useEffect(() => {
    const element = cell.current;
    if (!element || !numeric || disabled) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (event.deltaY) onChange(String(Math.max(0, Math.min(999, Number(value) + (event.deltaY < 0 ? 1 : -1)))));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [numeric, disabled, value, onChange]);
  return <span ref={cell} className={className} aria-label={label} title={label} onDoubleClick={(event) => {
    event.stopPropagation(); if (!disabled) { onEditStart(); setDraft(value); setEditing(true); }
  }}>
    {editing ? <input aria-label={label} autoFocus value={draft} maxLength={numeric ? 3 : 24} inputMode={numeric ? 'numeric' : 'text'}
      onFocus={event => event.currentTarget.select()} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onChange={event => { if (!numeric || /^\d{0,3}$/.test(event.target.value)) {
        const next = numeric ? String(Number(event.target.value) || 0) : event.target.value;
        if (numeric && next === '0') { event.currentTarget.value = next; event.currentTarget.select(); }
        selectZero.current = numeric && next === '0'; setDraft(next);
      } }}
      onBlur={commit} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit(); if (event.key === 'Escape') setEditing(false); }} />
      : <span style={{ '--scoreboard-text-length': Math.max(1, Array.from(value).length) } as React.CSSProperties}>{value}</span>}
  </span>;
}

export function ScoreboardFields({ names, score, winner, enabled, winnerEnabled, style = 'classic', editable = true, showControls = true, labels, onName, onScore, onWinner, onEditStart }: {
  names: [string, string]; score: ScoreboardScore; winner?: 'left' | 'right' | undefined; enabled: boolean;
  winnerEnabled: boolean;
  style?: ScoreboardStyle | undefined;
  editable?: boolean;
  showControls?: boolean;
  labels: { name: string; games: string; points: string; winner: string };
  onName(side: 'left' | 'right', value: string): void;
  onScore(field: keyof ScoreboardScore, value: number): void;
  onWinner(side: 'left' | 'right'): void;
  onEditStart(): void;
}) {
  return <>{style === 'red-blue' && <span className="custom-scoreboard-colon" aria-hidden="true"><i /><i /></span>}{(['left', 'right'] as const).map((side, row) => <div className={`custom-scoreboard-row is-${side}`} key={side}>
    <EditableCell className="custom-scoreboard-name" disabled={!editable} label={`${names[row]} ${labels.name}`} value={names[row]!} onEditStart={onEditStart} onChange={value => onName(side, value)} />
    <EditableCell className="custom-scoreboard-games" label={`${names[row]} ${labels.games}`} numeric disabled={!enabled} value={String(score[`${side}_games`] ?? 0)} onEditStart={onEditStart} onChange={value => onScore(`${side}_games`, Number(value))} />
    <EditableCell className="custom-scoreboard-points" label={`${names[row]} ${labels.points}`} numeric disabled={!enabled} value={String(score[side])} onEditStart={onEditStart} onChange={value => onScore(side, Number(value))} />
    {showControls && <button className="custom-scoreboard-winner" type="button" disabled={!winnerEnabled} aria-label={`${names[row]} ${labels.winner}`} aria-pressed={winner === side}
      onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onWinner(side); }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={winner === side ? 'm5 12 4 4L19 6' : 'M12 5v14M5 12h14'} /></svg>
    </button>}
  </div>)}</>;
}
