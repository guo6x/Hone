
import React from 'react';
import { render, Text, useInput, useStdin } from 'ink';

const App = () => {
  console.log('App rendering');
  const { stdin, setRawMode } = useStdin();
  
  React.useEffect(() => {
    console.log('App mounted');
    console.log('stdin.isTTY:', stdin.isTTY);
    try {
      console.log('Calling setRawMode(true)');
      setRawMode(true);
      console.log('setRawMode(true) succeeded');
    } catch (e) {
      console.error('setRawMode failed:', e);
    }
    
    return () => {
      console.log('App unmounting');
      try {
        setRawMode(false);
      } catch (e) {
        console.error('setRawMode(false) failed:', e);
      }
    };
  }, [setRawMode, stdin.isTTY]);

  return <Text>Hello from Ink repro!</Text>;
};

console.log('Starting Ink render');
const { waitUntilExit } = render(<App />);
console.log('Render called');

setTimeout(() => {
  console.log('Timeout reached, exiting');
  process.exit(0);
}, 5000);

await waitUntilExit();
console.log('waitUntilExit completed');
