import { useEffect, useRef, useState } from 'react';
import type { Messages } from './i18n';

type SupportPromptCopy = Pick<
  Messages,
  | 'supportPromptLabel'
  | 'supportPromptMessage'
  | 'supportPromptSponsor'
  | 'supportPromptReject'
  | 'supportPromptMore'
  | 'supportPromptSnooze'
>;

interface SupportPromptProps {
  copy: SupportPromptCopy;
  onSponsor: () => void;
  onReject: () => void;
  onSnooze: () => void;
}

export function SupportPrompt({ copy, onSponsor, onReject, onSnooze }: SupportPromptProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rejectGroupRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rejectGroupRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      moreButtonRef.current?.focus();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  return (
    <aside className="support-prompt" role="region" aria-label={copy.supportPromptLabel}>
      <p className="support-prompt-message">{copy.supportPromptMessage}</p>
      <div className="support-prompt-actions">
        <button className="support-sponsor-button" type="button" onClick={onSponsor}>
          {copy.supportPromptSponsor}
        </button>
        <div className="support-reject-group" ref={rejectGroupRef}>
          <button
            className="support-reject-button"
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onReject();
            }}
          >
            {copy.supportPromptReject}
          </button>
          <button
            ref={moreButtonRef}
            className="support-reject-more"
            type="button"
            aria-label={copy.supportPromptMore}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="support-chevron" aria-hidden="true" />
          </button>
          {menuOpen && (
            <div className="support-reject-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onSnooze();
                }}
              >
                {copy.supportPromptSnooze}
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
