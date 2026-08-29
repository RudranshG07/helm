import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Onboard from './onboard.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <Onboard />
  </StrictMode>,
);
