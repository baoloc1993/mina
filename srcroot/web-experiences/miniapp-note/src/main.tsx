import { createRoot } from 'react-dom/client';
import { getSdk } from './sdk';
import { App } from './ui/App';
import './ui/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Thiếu #root');
createRoot(root).render(<App sdk={getSdk()} />);
