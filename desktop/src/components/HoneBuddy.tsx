import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Species, renderSprite } from '../data/buddySprites';

export type BuddyState = 'idle' | 'thinking' | 'working' | 'success' | 'error' | 'suggestion';

interface Props {
  state: BuddyState;
  text?: string;
  species?: Species;
  onAction?: (action: string, data?: any) => void;
  style?: React.CSSProperties;
}

interface Pos { x: number; y: number; }

const STORAGE_KEY = 'hone-buddy-pos';

function loadPos(): Pos | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === 'number' && typeof p?.y === 'number') return p;
  } catch {}
  return null;
}

function clampToViewport(p: Pos, size = { w: 140, h: 100 }): Pos {
  const maxX = Math.max(0, window.innerWidth - size.w);
  const maxY = Math.max(0, window.innerHeight - size.h);
  return {
    x: Math.min(Math.max(0, p.x), maxX),
    y: Math.min(Math.max(0, p.y), maxY),
  };
}

const HoneBuddy: React.FC<Props> = ({ state, text, species = 'robot', onAction, style }) => {
  const [frame, setFrame] = useState(0);
  const [eye, setEye] = useState('o');
  const [bubbleText, setBubbleText] = useState<string | null>(null);
  const [showBubble, setShowBubble] = useState(false);
  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -- Drag state --
  // Default to bottom-right (40px margin) if no saved pos.
  const [pos, setPos] = useState<Pos>(() => {
    const saved = loadPos();
    if (saved) return clampToViewport(saved);
    // Default bottom-right of viewport
    const defaultX = (typeof window !== 'undefined' ? window.innerWidth : 1280) - 180;
    const defaultY = (typeof window !== 'undefined' ? window.innerHeight : 800) - 140;
    return { x: defaultX, y: defaultY };
  });
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef<Pos>({ x: 0, y: 0 });
  const didDrag = useRef(false);
  const dragStart = useRef<Pos>({ x: 0, y: 0 });

  // -- Animation Logic --
  useEffect(() => {
    const tickMs = state === 'working' ? 200 : state === 'thinking' ? 400 : 800;
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % 3);

      if (state === 'idle' && Math.random() > 0.8) {
        setEye('-');
        setTimeout(() => setEye('o'), 150);
      } else if (state === 'thinking') {
        const eyes = ['o', 'O', '0', 'o'];
        setEye(eyes[Math.floor(Math.random() * eyes.length)]);
      } else if (state === 'working') {
        setEye('^');
      } else if (state === 'error') {
        setEye('x');
      } else if (state === 'success') {
        setEye('♥');
      } else if (state === 'suggestion') {
        setEye('!');
      } else {
        setEye('o');
      }
    }, tickMs);
    return () => clearInterval(timer);
  }, [state]);

  // -- Bubble Logic --
  useEffect(() => {
    if (text) {
      setBubbleText(text);
      setShowBubble(true);
      if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = setTimeout(() => setShowBubble(false), 8000);
    }
  }, [text]);

  // -- Drag handlers --
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // left button only
    didDrag.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [pos]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (!didDrag.current && Math.hypot(dx, dy) > 3) {
      didDrag.current = true;
    }
    const next = clampToViewport({
      x: e.clientX - dragOffset.current.x,
      y: e.clientY - dragOffset.current.y,
    });
    setPos(next);
  }, [dragging]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    // Persist only if we actually moved
    if (didDrag.current) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch {}
    } else {
      // Treat as click → pet
      onAction?.('pet');
    }
  }, [dragging, pos, onAction]);

  // Reclamp on viewport resize so the buddy never gets stranded off-screen.
  useEffect(() => {
    const onResize = () => setPos(prev => clampToViewport(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const lines = renderSprite(species, eye, frame);

  const getGlowColor = () => {
    switch (state) {
      case 'thinking': return 'rgba(212, 168, 83, 0.4)';
      case 'working': return 'rgba(46, 204, 128, 0.3)';
      case 'error': return 'rgba(244, 88, 88, 0.4)';
      case 'success': return 'rgba(212, 168, 83, 0.5)';
      case 'suggestion': return 'rgba(212, 168, 83, 0.6)';
      default: return 'transparent';
    }
  };

  const getTextColor = () => {
    switch (state) {
      case 'error': return '#F45858';
      case 'success': return '#2ECC80';
      case 'thinking':
      case 'suggestion': return '#D4A853';
      default: return 'inherit';
    }
  };

  return (
    <div
      style={{
        ...s.container,
        left: pos.x,
        top: pos.y,
        cursor: dragging ? 'grabbing' : 'grab',
        opacity: dragging ? 0.85 : 1,
        ...style,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      title="按住拖动，松开摸头"
    >
      {showBubble && bubbleText && (
        <div style={s.bubble}>
          {bubbleText}
          <div style={s.bubbleTail} />
        </div>
      )}

      <pre style={{
        ...s.sprite,
        color: getTextColor(),
        textShadow: state !== 'idle' ? `0 0 8px ${getGlowColor()}` : 'none',
        animation: dragging ? 'none'
          : state === 'thinking' ? 'buddy-pulse 2s infinite'
          : state === 'working' ? 'buddy-bounce 0.4s infinite'
          : state === 'error' ? 'buddy-shake 0.5s infinite' : 'none'
      }}>
        {lines.join('\n')}
      </pre>

      <style>{`
        @keyframes buddy-pulse {
          0% { opacity: 0.8; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.02); }
          100% { opacity: 0.8; transform: scale(1); }
        }
        @keyframes buddy-bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-2px); }
        }
        @keyframes buddy-shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-2px); }
          75% { transform: translateX(2px); }
        }
        @keyframes buddy-fade-in {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    pointerEvents: 'auto',
    userSelect: 'none',
    touchAction: 'none',
    transition: 'opacity 0.15s',
  },
  bubble: {
    background: 'var(--hone-surfaceRaised, #1A1E26)',
    border: '1px solid var(--hone-accent, #D4A853)',
    borderRadius: 12,
    padding: '8px 12px',
    fontSize: 12,
    color: 'var(--hone-text, #E4E8F0)',
    maxWidth: 200,
    marginBottom: 8,
    position: 'relative',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    animation: 'buddy-fade-in 0.3s ease-out',
    pointerEvents: 'none',
  },
  bubbleTail: {
    position: 'absolute',
    bottom: -6,
    left: '50%',
    marginLeft: -6,
    width: 0,
    height: 0,
    borderLeft: '6px solid transparent',
    borderRight: '6px solid transparent',
    borderTop: '6px solid var(--hone-accent, #D4A853)',
  },
  sprite: {
    fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
    fontSize: 12,
    lineHeight: '1.2',
    margin: 0,
    transition: 'all 0.3s ease',
  },
};

export default HoneBuddy;
