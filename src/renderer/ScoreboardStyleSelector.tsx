import type { ScoreboardStyle } from '../shared/contracts';
import { scoreboardAspectRatio, scoreboardGamesColor } from '../domain/scoreboard';
import type { Messages } from './i18n';
import { ScoreboardFields } from './ScoreboardFields';

const noop = () => undefined;

export function ScoreboardStyleSelector({ value, onChange, translations: t }: {
  value: ScoreboardStyle;
  onChange(style: ScoreboardStyle): void;
  translations: Messages;
}) {
  const labels: Record<ScoreboardStyle, string> = {
    classic: t.scoreboardStyleClassic,
    'classic-orange': t.scoreboardStyleOrange,
    'classic-green': t.scoreboardStyleGreen,
    'red-blue': t.scoreboardStyleRedBlue,
  };
  return <div className="scoreboard-style-options" role="radiogroup" aria-label={t.scoreboardStyle}>
    {(['classic', 'classic-orange', 'classic-green', 'red-blue'] as const).map(style => <label className={`scoreboard-style-option${value === style ? ' is-selected' : ''}`} key={style}>
      <div className="scoreboard-style-preview" aria-hidden="true">
        <div className={`custom-scoreboard is-${style}`} style={{ '--scoreboard-aspect': scoreboardAspectRatio(style), '--scoreboard-games-color': scoreboardGamesColor(style) } as React.CSSProperties}>
          <ScoreboardFields style={style} names={[t.scoreboardPreviewLeft, t.scoreboardPreviewRight]} score={{ left: 1, right: 1, left_games: 0, right_games: 0 }}
            enabled={false} winnerEnabled={false} editable={false} showControls={false}
            labels={{ name: '', games: '', points: '', winner: '' }} onName={noop} onScore={noop} onWinner={noop} onEditStart={noop} />
        </div>
      </div>
      <span className="scoreboard-style-choice"><input type="radio" aria-label={labels[style]} name="settings-scoreboard-style" value={style} checked={value === style} onChange={() => onChange(style)} /><span>{value === style ? t.scoreboardStyleSelected : t.scoreboardStyleSelect}</span></span>
    </label>)}
  </div>;
}
