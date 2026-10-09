import { createRoot } from 'react-dom/client';
import { getSdk } from './sdk';
import { App } from './ui/App';
import './ui/styles.css';

// Bàn phím ảo: trên WebView của shell vùng nhìn thấy (visualViewport) thấp hơn layout viewport khi bàn phím mở → gắn vào --vvh.
const vv = window.visualViewport;
if (vv) {
  const sync = () => {
    document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    document.documentElement.classList.toggle('kb-open', window.innerHeight - vv.height > 120);
  };
  sync();
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', () => window.scrollTo(0, 0));
}

const root = document.getElementById('root');
if (!root) throw new Error('Thiếu #root');
createRoot(root).render(<App sdk={getSdk()} />);
