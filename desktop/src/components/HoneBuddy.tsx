import React, { useState, useEffect, useRef, useCallback } from 'react';
import { type Species, type SvgShape, getSpeciesData, getEyeShapes, eyePositions } from '../data/buddySprites';

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

/** Render a single SvgShape into a JSX <svg> child element */
function SvgEl({ shape }: { shape: SvgShape }) {
  const { tag, attrs } = shape;
  const keyed: Record<string, any> = {};
  for (const [k, v] of Object.entries(attrs)) {
    keyed[k] = v;
  }
  return React.createElement(tag, keyed);
}

const HoneBuddy: React.FC<Props> = ({ state, text, species = 'robot', onAction, style }) => {
  const [frame, setFrame] = useState(0);
  const [bubbleText, setBubbleText] = useState<string | null>(null);
  const [showBubble, setShowBubble] = useState(false);
  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -- Drag state --
  const [pos, setPos] = useState<Pos>(() => {
    const saved = loadPos();
    if (saved) return clampToViewport(saved);
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

  // Clear any pending bubble timer on unmount so it can't fire after teardown.
  useEffect(() => () => { if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current); }, []);

  // -- Drag handlers --
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
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
    if (didDrag.current) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch {}
    } else {
      onAction?.('pet');
    }
  }, [dragging, pos, onAction]);

  useEffect(() => {
    const onResize = () => setPos(prev => clampToViewport(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Build SVG elements for current species + state + frame
  const speciesData = getSpeciesData(species);
  const [lx, ly, rx, ry] = eyePositions[species] || [33, 27, 47, 27];
  const eyeShapes = getEyeShapes(state, frame, lx, ly, rx, ry);

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

  const animClass = dragging ? ''
    : state === 'thinking' ? 'buddy-pulse'
    : state === 'working' ? 'buddy-breathe'
    : state === 'error' ? 'buddy-shake' : '';

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
        <div
          style={{
            ...s.bubble,
            pointerEvents: 'auto' as const,
            cursor: state === 'error' || state === 'suggestion' ? 'pointer' : 'default',
          }}
          onPointerDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => {
            e.stopPropagation();
            if (state === 'error' || state === 'suggestion') {
              onAction?.('open_bubble', { state, text: bubbleText });
            }
            setShowBubble(false);
          }}
          title={state === 'error' || state === 'suggestion' ? '点击查看' : ''}
        >
          {bubbleText}
          {(state === 'error' || state === 'suggestion') && (
            <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.7 }}>→</span>
          )}
          <div style={s.bubbleTail} />
        </div>
      )}

      <div
        className={animClass}
        style={{
          filter: state !== 'idle'
            ? `drop-shadow(0 0 8px ${getGlowColor()})`
            : 'none',
        }}
      >
        <svg
          width="80"
          height="80"
          viewBox="0 0 80 80"
          xmlns="http://www.w3.org/2000/svg"
          style={{ display: 'block' }}
        >
          {/* Body shapes */}
          {speciesData.bodyShapes.map((s, i) => (
            <SvgEl key={`body-${i}`} shape={s} />
          ))}
          {/* Decorations (ears, whiskers, gills, etc.) */}
          {speciesData.decorations.map((s, i) => (
            <SvgEl key={`deco-${i}`} shape={s} />
          ))}
          {/* Eyes — dynamic per state/frame */}
          {eyeShapes.map((s, i) => (
            <SvgEl key={`eye-${i}`} shape={s} />
          ))}
        </svg>
      </div>

      <style>{`
        @keyframes buddy-pulse {
          0% { opacity: 0.8; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.02); }
          100% { opacity: 0.8; transform: scale(1); }
        }
        @keyframes buddy-breathe {
          0%, 100% { opacity: 0.9; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.02); }
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
        .buddy-pulse { animation: buddy-pulse 2s infinite; }
        .buddy-breathe { animation: buddy-breathe 2s infinite; }
        .buddy-shake { animation: buddy-shake 0.5s infinite; }
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
};

export default HoneBuddy;
