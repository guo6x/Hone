import React, { useState, useEffect, useRef } from 'react';
import { Species, renderSprite } from '../data/buddySprites';

export type BuddyState = 'idle' | 'thinking' | 'working' | 'success' | 'error' | 'suggestion';

interface Props {
  state: BuddyState;
  text?: string;
  species?: Species;
  onAction?: (action: string, data?: any) => void;
  style?: React.CSSProperties;
}

const HoneBuddy: React.FC<Props> = ({ state, text, species = 'robot', onAction, style }) => {
  const [frame, setFrame] = useState(0);
  const [eye, setEye] = useState('o');
  const [bubbleText, setBubbleText] = useState<string | null>(null);
  const [showBubble, setShowBubble] = useState(false);
  const bubbleTimerRef = useRef<NodeJS.Timeout | null>(null);

  // -- Animation Logic --
  useEffect(() => {
    const tickMs = state === 'working' ? 200 : state === 'thinking' ? 400 : 800;
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % 3);
      
      // Randomly blink if idle
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
    <div style={{
      ...s.container,
      ...style
    }} onClick={() => onAction?.('pet')}>
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
        animation: state === 'thinking' ? 'buddy-pulse 2s infinite' : 
                   state === 'working' ? 'buddy-bounce 0.4s infinite' : 
                   state === 'error' ? 'buddy-shake 0.5s infinite' : 'none'
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
    bottom: 40,
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    cursor: 'pointer',
    pointerEvents: 'auto',
    userSelect: 'none',
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
