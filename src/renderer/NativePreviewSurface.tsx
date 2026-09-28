import { useEffect, useRef } from 'react';
import type { PreviewScoreboard, ScoreboardField } from '../shared/native-preview';
import type { useNativePreview } from './use-native-preview';
import { SCOREBOARD_MAX_SCALE, SCOREBOARD_MIN_SCALE, SCOREBOARD_WIDTH_FRACTION, SCOREBOARD_PREVIEW_WIDTH_FRACTION, scoreboardHeightFraction } from '../domain/scoreboard';

type Position = { x: number; y: number; scale: number };
export function NativePreviewSurface({ preview, scoreboard, onPosition, onToggle, onWinner, onEdit, label }: {
  preview: ReturnType<typeof useNativePreview>; scoreboard: PreviewScoreboard;
  onPosition(value: Position): void; onToggle(): void; label: string;
  onWinner(clipId: string, side: 'left' | 'right'): void;
  onEdit(clipId: string, field: ScoreboardField, value: string): void;
}) {
  const drag = useRef<(Position & { startX: number; startY: number; corner: string | null }) | null>(null);
  const click = useRef<{ x: number; y: number; field: ScoreboardField | null; side: 'left' | 'right' | null; clipId: string; video: boolean } | null>(null);
  const lastClick = useRef<{ field: ScoreboardField; clipId: string; time: number } | null>(null);
  useEffect(() => { preview.send({ type: 'scoreboard', scoreboard }); }, [preview.send, preview.status, scoreboard.enabled, scoreboard.x, scoreboard.y, scoreboard.scale, scoreboard.aspect, scoreboard.left, scoreboard.right, scoreboard.leftGames, scoreboard.rightGames, scoreboard.leftName, scoreboard.rightName, scoreboard.clipId, scoreboard.winner]);
  preview.onInput.current = event => {
    const bw = SCOREBOARD_WIDTH_FRACTION, pw = SCOREBOARD_PREVIEW_WIDTH_FRACTION;
    const bh = scoreboardHeightFraction(scoreboard.aspect);
    if (event.type === 'scoreboard-edit') { onEdit(event.clipId, event.field, event.value); return; }
    if (event.type === 'key') {
      const delta = event.shift ? .05 : .01;
      if (scoreboard.enabled && event.key.startsWith('Arrow')) {
        onPosition({ scale: scoreboard.scale,
          x: Math.max(0, Math.min(1 - pw * scoreboard.scale, scoreboard.x + (event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0))),
          y: Math.max(0, Math.min(1 - bh * scoreboard.scale, scoreboard.y + (event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0))),
        });
      } else window.dispatchEvent(new KeyboardEvent('keydown', { code: event.key, key: event.key === 'Space' ? ' ' : event.key, shiftKey: event.shift, bubbles: true }));
      return;
    }
    if (event.type !== 'pointer' && event.type !== 'wheel') return;
    const vw = Math.min(event.width, event.height * scoreboard.aspect), vh = vw / scoreboard.aspect;
    if (!vw || !vh) return;
    const x = (event.x - (event.width - vw) / 2) / vw, y = (event.y - (event.height - vh) / 2) / vh;
    const rx = (x - scoreboard.x) / (bw * scoreboard.scale), ry = (y - scoreboard.y) / (bh * scoreboard.scale);
    const inRow = scoreboard.enabled && ry >= 0 && ry <= 1;
    const side = ry < .5 ? 'left' : 'right';
    const field: ScoreboardField | null = inRow && rx >= 0 && rx <= 1 ? (rx < .76 ? `${side}Name` : rx < .88 ? `${side}Games` : side) : null;
    const winnerButton = inRow && rx >= 1.02 && rx <= 1.14;
    if (event.type === 'wheel') {
      if (field && !field.endsWith('Name') && scoreboard.clipId && event.delta) {
        const value = scoreboard[field] as number | undefined;
        onEdit(scoreboard.clipId, field, String(Math.max(0, Math.min(999, (value ?? 0) + (event.delta > 0 ? 1 : -1)))));
      }
      return;
    }
    if (event.action === 'down') {
      const right = scoreboard.x + bw * scoreboard.scale, bottom = scoreboard.y + bh * scoreboard.scale;
      const inBoard = scoreboard.enabled && x >= scoreboard.x - 8 / vw && x <= right + 8 / vw && y >= scoreboard.y - 8 / vh && y <= bottom + 8 / vh;
      click.current = { x: event.x, y: event.y, field, side: winnerButton ? side : null, clipId: scoreboard.clipId ?? '', video: !inBoard && !winnerButton };
      if (inBoard && !winnerButton) {
        const horizontal = Math.abs(x - scoreboard.x) < 7 / vw ? 'left' : Math.abs(x - right) < 7 / vw ? 'right' : null;
        const vertical = Math.abs(y - scoreboard.y) < 7 / vh ? 'top' : Math.abs(y - bottom) < 7 / vh ? 'bottom' : null;
        drag.current = { x: scoreboard.x, y: scoreboard.y, scale: scoreboard.scale, startX: x, startY: y, corner: horizontal && vertical ? `${vertical}-${horizontal}` : null };
      }
    } else if (event.action === 'move' && drag.current) {
      const d = drag.current, dx = x - d.startX, dy = y - d.startY;
      if (!d.corner) onPosition({ scale: d.scale, x: Math.max(0, Math.min(1 - pw * d.scale, d.x + dx)), y: Math.max(0, Math.min(1 - bh * d.scale, d.y + dy)) });
      else {
        const right = d.corner.endsWith('right'), bottom = d.corner.startsWith('bottom');
        const ax = right ? d.x : d.x + bw * d.scale, ay = bottom ? d.y : d.y + bh * d.scale;
        const vx = (right ? 1 : -1) * bw, vy = (bottom ? 1 : -1) * bh;
        const max = Math.min(SCOREBOARD_MAX_SCALE, (right ? 1 - ax : ax) / bw, (bottom ? 1 - ay : ay) / bh);
        const scale = Math.max(SCOREBOARD_MIN_SCALE, Math.min(max, d.scale + (dx * vx + dy * vy) / (vx * vx + vy * vy)));
        onPosition({ scale, x: Math.max(0, Math.min(1 - pw * scale, right ? ax : ax - bw * scale)), y: bottom ? ay : ay - bh * scale });
      }
    } else if (event.action === 'up' || event.action === 'cancel') {
      const c = click.current;
      if (event.action === 'up' && c && Math.hypot(event.x - c.x, event.y - c.y) < 5) {
        if (c.video) onToggle();
        else if (c.side && c.clipId && winnerButton && c.side === side) onWinner(c.clipId, c.side);
        else if (c.field && c.field === field && !drag.current?.corner && (c.clipId || c.field.endsWith('Name'))) {
          const prior = lastClick.current;
          if (prior?.field === c.field && prior.clipId === c.clipId && Date.now() - prior.time < 450) {
            preview.send({ type: 'scoreboard-edit', field: c.field, clipId: c.clipId }); lastClick.current = null;
          } else lastClick.current = { field: c.field, clipId: c.clipId, time: Date.now() };
        }
      }
      drag.current = null; click.current = null;
    }
  };
  return <div ref={preview.surfaceRef} className="native-preview-surface" role="button" tabIndex={0} aria-label={label} onClick={onToggle} data-native-preview="libmpv" />;
}
