// Plugin Vite của mock SDK: phục vụ fixture từ đĩa và làm "native fetch" cho net.fetch (không CORS, không tự theo chuyển hướng).
//   GET  /__mock/fixtures        → [{ name, id, version, name }]
//   GET  /__mock/fixture/<tên>   → { manifest, html (đã nhúng css/js/ảnh tương đối), migrations[], dir }
//   POST /__mock/fetch           → MỘT bước HTTP (redirect: manual) — host kiểm lại từng bước
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp' };

export interface MockPluginOptions {
  /** Thư mục chứa các fixture `miniapp-*`. */
  fixturesRoot: string;
  /** Thư mục fixture mở mặc định (đối số của `npm run mock`); có thể nằm ngoài fixturesRoot. */
  defaultDir: string | null;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        fail(new Error('body quá lớn'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

const isFixtureDir = (d: string) => existsSync(join(d, 'manifest.json')) && statSync(d).isDirectory();

export function listFixtureDirs(o: MockPluginOptions): Map<string, string> {
  const out = new Map<string, string>();
  if (existsSync(o.fixturesRoot)) {
    for (const n of readdirSync(o.fixturesRoot).sort()) {
      const d = join(o.fixturesRoot, n);
      if (n.startsWith('miniapp-') && isFixtureDir(d)) out.set(n, d);
    }
  }
  if (o.defaultDir && isFixtureDir(o.defaultDir)) out.set(basename(o.defaultDir), o.defaultDir);
  return out;
}

/** Nhúng tài nguyên tương đối vào HTML: iframe sandbox (origin mờ) không tải được file từ trang cha. */
export function inlineAssets(dir: string, html: string): string {
  const local = (u: string) => !/^([a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(u);
  const read = (u: string) => {
    const p = resolve(dir, u.split(/[?#]/)[0]);
    if (!p.startsWith(resolve(dir)) || !existsSync(p)) return null;
    return p;
  };
  return html
    .replace(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi, (tag) => {
      const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1];
      const p = href && local(href) ? read(href) : null;
      return p ? `<style>\n${readFileSync(p, 'utf8')}\n</style>` : tag;
    })
    .replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, a, src, b) => {
      const p = local(src) ? read(src) : null;
      return p ? `<script${a}${b}>\n${readFileSync(p, 'utf8')}\n</script>` : tag;
    })
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (tag, pre, src, post) => {
      const p = local(src) ? read(src) : null;
      if (!p) return tag;
      return `${pre}data:${MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'};base64,${readFileSync(p).toString('base64')}${post}`;
    });
}

export function loadFixture(dir: string) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const entry = join(dir, manifest.entry ?? 'index.html');
  const html = inlineAssets(dirname(entry), readFileSync(entry, 'utf8'));
  const mdir = join(dir, 'migrations');
  const migrations = existsSync(mdir)
    ? readdirSync(mdir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => ({ name: f, sql: readFileSync(join(mdir, f), 'utf8') }))
    : [];
  return { manifest, html, migrations, dir };
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function mockPlugin(o: MockPluginOptions): Plugin {
  return {
    name: 'mina-mock-sdk',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/__mock/')) return next();
        // Chỉ phục vụ chính máy này: /__mock/fetch là một proxy mạng, không được thành cổng mở.
        if (!LOCAL_HOST.test(req.headers.host ?? '')) return json(res, 403, { error: 'chỉ localhost' });
        // Chặn trang web khác trỏ POST vào đây (CSRF/SSRF): Origin, nếu có, phải trùng Host.
        const origin = req.headers.origin;
        if (origin && origin !== 'null' && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'sai origin' });
        if (origin === 'null') return json(res, 403, { error: 'sai origin' });
        try {
          if (url.pathname === '/__mock/fixtures') {
            const list = [...listFixtureDirs(o)].map(([name, dir]) => {
              const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
              return { name, id: m.id, version: m.version, title: m.name };
            });
            return json(res, 200, { fixtures: list, default: o.defaultDir ? basename(o.defaultDir) : (list[0]?.name ?? null) });
          }
          if (url.pathname.startsWith('/__mock/fixture/')) {
            const name = decodeURIComponent(url.pathname.slice('/__mock/fixture/'.length));
            const dir = listFixtureDirs(o).get(name);
            if (!dir) return json(res, 404, { error: `không có fixture ${name}` });
            return json(res, 200, loadFixture(dir));
          }
          if (url.pathname === '/__mock/fetch' && req.method === 'POST') {
            const r = JSON.parse(await readBody(req));
            const target = new URL(r.url);
            if (target.protocol !== 'http:' && target.protocol !== 'https:') return json(res, 400, { error: 'chỉ http(s)' });
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), Math.min(Number(r.timeoutMs) || 15000, 30000));
            try {
              const resp = await fetch(target, {
                method: r.method,
                headers: r.headers,
                body: r.body ?? undefined,
                redirect: 'manual',
                signal: ctl.signal,
              });
              const headers: Record<string, string> = {};
              resp.headers.forEach((v, k) => (headers[k] = v));
              const body = await resp.text();
              return json(res, 200, { status: resp.status, headers, body: body.length > 6 * 1024 * 1024 ? body.slice(0, 6 * 1024 * 1024) : body });
            } catch (e) {
              const err = e as Error & { cause?: { code?: string } };
              return json(res, 200, { error: err.name === 'AbortError' ? 'timeout' : `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}` });
            } finally {
              clearTimeout(timer);
            }
          }
          return json(res, 404, { error: 'không rõ' });
        } catch (e) {
          return json(res, 500, { error: (e as Error).message });
        }
      });
    },
  };
}
