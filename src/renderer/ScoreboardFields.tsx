import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ScoreboardScore } from '../shared/contracts';

function EditableCell({ value, label, numeric = false, disabled = false, className, onChange }: {
  value: string; label: string; numeric?: boolean; disabled?: boolean; className: string;
  onChange(value: string): void;
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
    event.stopPropagation(); if (!disabled) { setDraft(value); setEditing(true); }
  }}>
    {editing ? <input aria-label={label} autoFocus value={draft} maxLength={numeric ? 3 : 24} inputMode={numeric ? 'numeric' : 'text'}
      onFocus={event => event.currentTarget.select()} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onChange={event => { if (!numeric || /^\d{0,3}$/.test(event.target.value)) {
        const next = numeric ? String(Number(event.target.value) || 0) : event.target.value;
        if (numeric && next === '0') { event.currentTarget.value = next; event.currentTarget.select(); }
        selectZero.current = numeric && next === '0'; setDraft(next);
      } }}
      onBlur={commit} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit(); if (event.key === 'Escape') setEditing(false); }} />
      : <span style={numeric ? undefined : { fontSize: `min(1.72cqw, ${32 / Math.max(1, Array.from(value).length)}cqw)` }}>{value}</span>}
  </span>;
}

export function ScoreboardFields({ names, score, winner, enabled, labels, onName, onScore, onWinner }: {
  names: [string, string]; score: ScoreboardScore; winner?: 'left' | 'right' | undefined; enabled: boolean;
  labels: { name: string; games: string; points: string; winner: string };
  onName(side: 'left' | 'right', value: string): void;
  onScore(field: keyof ScoreboardScore, value: number): void;
  onWinner(side: 'left' | 'right'): void;
}) {
  return <>{(['left', 'right'] as const).map((side, row) => <div className="custom-scoreboard-row" key={side}>
    <EditableCell className="custom-scoreboard-name" label={`${names[row]} ${labels.name}`} value={names[row]!} onChange={value => onName(side, value)} />
    <EditableCell className="custom-scoreboard-games" label={`${names[row]} ${labels.games}`} numeric disabled={!enabled} value={String(score[`${side}_games`] ?? 0)} onChange={value => onScore(`${side}_games`, Number(value))} />
    <EditableCell className="custom-scoreboard-points" label={`${names[row]} ${labels.points}`} numeric disabled={!enabled} value={String(score[side])} onChange={value => onScore(side, Number(value))} />
    <button className="custom-scoreboard-winner" type="button" disabled={!enabled} aria-label={`${names[row]} ${labels.winner}`} aria-pressed={winner === side}
      onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onWinner(side); }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={winner === side ? 'm5 12 4 4L19 6' : 'M12 5v14M5 12h14'} /></svg>
    </button>
  </div>)}</>;
}
