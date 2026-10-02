import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/spline-sans-mono';
import App from './App.jsx';
import './styles.css';
import './bryntum-tint.css';

createRoot(document.getElementById('root')).render(<App />);
