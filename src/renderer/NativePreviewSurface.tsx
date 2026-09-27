import { useEffect, useRef } from 'react';
import type { PreviewScoreboard } from '../shared/native-preview';
import type { useNativePreview } from './use-native-preview';
import { SCOREBOARD_MAX_SCALE, SCOREBOARD_MIN_SCALE, SCOREBOARD_WIDTH_FRACTION, scoreboardHeightFraction } from '../domain/scoreboard';

type Position = { x: number; y: number; scale: number };
export function NativePreviewSurface({ preview, scoreboard, onPosition, onToggle, label }: {
  preview: ReturnType<typeof useNativePreview>; scoreboard: PreviewScoreboard;
  onPosition(value: Position): void; onToggle(): void; label: string;
}) {
  const drag = useRef<(Position & { startX: number; startY: number; corner: string | null }) | null>(null);
  const click = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { preview.send({ type: 'scoreboard', scoreboard }); }, [preview.send, preview.status, scoreboard.enabled, scoreboard.x, scoreboard.y, scoreboard.scale, scoreboard.aspect, scoreboard.left, scoreboard.right, scoreboard.leftName, scoreboard.rightName]);
  preview.onInput.current = event => {
    const bw = SCOREBOARD_WIDTH_FRACTION;
    const bh = scoreboardHeightFraction(scoreboard.aspect);
    if (event.type === 'key') {
      const delta = event.shift ? .05 : .01;
      if (scoreboard.enabled && event.key.startsWith('Arrow')) {
        onPosition({ scale: scoreboard.scale,
          x: Math.max(0, Math.min(1 - bw * scoreboard.scale, scoreboard.x + (event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0))),
          y: Math.max(0, Math.min(1 - bh * scoreboard.scale, scoreboard.y + (event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0))),
        });
      } else window.dispatchEvent(new KeyboardEvent('keydown', { code: event.key, key: event.key === 'Space' ? ' ' : event.key, shiftKey: event.shift, bubbles: true }));
      return;
    }
    if (event.type !== 'pointer') return;
    const vw = Math.min(event.width, event.height * scoreboard.aspect), vh = vw / scoreboard.aspect;
    if (!vw || !vh) return;
    const x = (event.x - (event.width - vw) / 2) / vw, y = (event.y - (event.height - vh) / 2) / vh;
    if (event.action === 'down') {
      const right = scoreboard.x + bw * scoreboard.scale, bottom = scoreboard.y + bh * scoreboard.scale;
      if (scoreboard.enabled && x >= scoreboard.x - 8 / vw && x <= right + 8 / vw && y >= scoreboard.y - 8 / vh && y <= bottom + 8 / vh) {
        const horizontal = Math.abs(x - scoreboard.x) < 10 / vw ? 'left' : Math.abs(x - right) < 10 / vw ? 'right' : null;
        const vertical = Math.abs(y - scoreboard.y) < 10 / vh ? 'top' : Math.abs(y - bottom) < 10 / vh ? 'bottom' : null;
        drag.current = { x: scoreboard.x, y: scoreboard.y, scale: scoreboard.scale, startX: x, startY: y, corner: horizontal && vertical ? `${vertical}-${horizontal}` : null };
        click.current = null;
      } else click.current = { x: event.x, y: event.y };
    } else if (event.action === 'move' && drag.current) {
      const d = drag.current, dx = x - d.startX, dy = y - d.startY;
      if (!d.corner) onPosition({ scale: d.scale, x: Math.max(0, Math.min(1 - bw * d.scale, d.x + dx)), y: Math.max(0, Math.min(1 - bh * d.scale, d.y + dy)) });
      else {
        const right = d.corner.endsWith('right'), bottom = d.corner.startsWith('bottom');
        const ax = right ? d.x : d.x + bw * d.scale, ay = bottom ? d.y : d.y + bh * d.scale;
        const vx = (right ? 1 : -1) * bw, vy = (bottom ? 1 : -1) * bh;
        const max = Math.min(SCOREBOARD_MAX_SCALE, (right ? 1 - ax : ax) / bw, (bottom ? 1 - ay : ay) / bh);
        const scale = Math.max(SCOREBOARD_MIN_SCALE, Math.min(max, d.scale + (dx * vx + dy * vy) / (vx * vx + vy * vy)));
        onPosition({ scale, x: right ? ax : ax - bw * scale, y: bottom ? ay : ay - bh * scale });
      }
    } else if (event.action === 'up' || event.action === 'cancel') {
      if (event.action === 'up' && click.current && Math.hypot(event.x - click.current.x, event.y - click.current.y) < 5) onToggle();
      drag.current = null; click.current = null;
    }
  };
  return <div ref={preview.surfaceRef} className="native-preview-surface" role="button" tabIndex={0} aria-label={label} onClick={onToggle} data-native-preview="libmpv" />;
}
