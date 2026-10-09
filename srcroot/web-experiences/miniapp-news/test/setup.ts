// DOMParser cho test chạy trên Node (WebView thật có sẵn). jsdom có DOMParser đúng chuẩn (CDATA, HTML5); môi trường test vẫn là 'node'
// để import được node:sqlite của giàn test.
import { JSDOM } from 'jsdom';

const w = new JSDOM('').window;
(globalThis as unknown as { DOMParser: unknown }).DOMParser = w.DOMParser;
