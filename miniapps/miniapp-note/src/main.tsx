import { createRoot } from 'react-dom/client';
import { getSdk } from './sdk';
import { App } from './ui/App';
import './ui/styles.css';

// Bàn phím ảo: trên WebView của shell vùng nhìn thấy (visualViewport) thấp hơn layout viewport khi bàn phím mở. Gắn chiều cao thật vào
// --vvh để thanh công cụ luôn nằm sát TRÊN bàn phím (dogfood newbie #1). Máy tính / mock: visualViewport.height = innerHeight, không đổi gì.
const vv = window.visualViewport;
if (vv) {
  const sync = () => document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
  sync();
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', () => window.scrollTo(0, 0)); // không để trang trượt khi bàn phím mở
}

const root = document.getElementById('root');
if (!root) throw new Error('Thiếu #root');
createRoot(root).render(<App sdk={getSdk()} />);
