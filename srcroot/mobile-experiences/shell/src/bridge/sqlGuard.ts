// SQL guard (CAP-RT-02, AC-6): fail-closed. Mini app chỉ được gửi một câu SELECT/INSERT/UPDATE/DELETE
// đơn giản vào bảng đã khai trong manifest.tables. Mọi thứ không hiểu được → SQL_REJECTED.
// Bridge đổi tên bảng (items → app_hello_items), viết lại DELETE thành xoá mềm, và ghi đè cột hệ thống.

export class SqlRejected extends Error {
  readonly code = 'SQL_REJECTED';
}

export interface GuardContext {
  allowedTables: string[]; // tên ngắn trong manifest.tables
  prefix: string; // vd "app_hello_"
  tenantId: string;
  now: string; // ISO
  /** SELECT mặc định tự lọc dòng đã xoá mềm; {includeDeleted: true} tắt bộ lọc (DECISIONS 2026-10-08). */
  includeDeleted?: boolean;
}
export interface Guarded {
  sql: string;
  params: unknown[];
  kind: 'select' | 'insert' | 'update' | 'delete';
}

const SYSTEM_COLS = new Set(['tenant_id', 'created_at', 'updated_at', 'deleted_at']);
const FORBIDDEN = new Set([
  'attach', 'detach', 'pragma', 'drop', 'create', 'alter', 'vacuum', 'reindex', 'replace',
  'load_extension', 'union', 'with', 'returning', 'on', 'conflict', 'sqlite_master', 'sqlite_schema',
]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLAUSE_START = new Set(['where', 'group', 'order', 'limit', 'offset', 'having']);
const NOT_ALIAS = new Set([...CLAUSE_START, 'join', 'natural', 'cross', 'left', 'right', 'inner', 'outer', 'full', 'union', 'intersect', 'except', 'on', 'using', 'window', 'indexed', 'not']);

/** `WHERE …` gốc (token đầu là WHERE, có thể rỗng) → điều kiện thêm `deleted_at IS NULL` — UPDATE/DELETE không chạm dòng đã xoá. */
function liveWhere(whereTokens: string[]): string {
  if (whereTokens.some((t) => t.toLowerCase() === 'order' || t.toLowerCase() === 'limit')) reject('ORDER/LIMIT không dùng trong UPDATE/DELETE');
  if (!whereTokens.length) return ' WHERE deleted_at IS NULL';
  return ` WHERE deleted_at IS NULL AND ( ${join(whereTokens.slice(1))} )`;
}

function reject(why: string): never {
  throw new SqlRejected(why);
}

/** Tách câu thành token; chuỗi trong nháy đơn giữ nguyên làm 1 token. Từ chối comment, nháy kép/backtick/[ ]. */
function tokenize(sql: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) reject('chuỗi không đóng');
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out.push(sql.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') reject('comment');
    if (c === '/' && sql[i + 1] === '*') reject('comment');
    if (c === '"' || c === '`' || c === '[') reject('định danh có nháy');
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      out.push(sql.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[0-9.]/.test(sql[j])) j++;
      out.push(sql.slice(i, j));
      i = j;
      continue;
    }
    if ('(),*=?<>!.+-;%'.includes(c)) {
      const two = sql.slice(i, i + 2);
      if (['<=', '>=', '<>', '!=', '=='].includes(two)) {
        out.push(two);
        i += 2;
        continue;
      }
      out.push(c);
      i++;
      continue;
    }
    reject(`ký tự không được phép: ${c}`);
  }
  return out;
}

function mapTable(name: string, ctx: GuardContext): string {
  if (!IDENT.test(name)) reject('tên bảng không hợp lệ');
  if (!ctx.allowedTables.includes(name)) reject(`bảng không khai trong manifest: ${name}`);
  return ctx.prefix + name;
}

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Cắt danh sách theo dấu phẩy ở mức ngoặc 0. */
function splitTop(tokens: string[]): string[][] {
  const parts: string[][] = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t === '(') depth++;
    if (t === ')') depth--;
    if (t === ',' && depth === 0) {
      parts.push([]);
      continue;
    }
    parts[parts.length - 1].push(t);
  }
  return parts;
}

function join(tokens: string[]): string {
  return tokens.join(' ');
}

export function guardSql(rawSql: string, rawParams: unknown[], ctx: GuardContext): Guarded {
  if (typeof rawSql !== 'string' || !rawSql.trim()) reject('rỗng');
  let tokens = tokenize(rawSql);
  if (tokens[tokens.length - 1] === ';') tokens = tokens.slice(0, -1);
  // một câu duy nhất + không từ khoá cấm
  if (tokens.includes(';')) reject('nhiều câu lệnh');
  for (const t of tokens) if (FORBIDDEN.has(t.toLowerCase())) reject(`từ khoá bị cấm: ${t}`);
  const head = tokens[0]?.toLowerCase();
  const params = [...rawParams];

  if (head === 'select') {
    const out: string[] = [];
    let seenFrom = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const lower = t.toLowerCase();
      if (lower === 'select' && i > 0) reject('subquery');
      if (lower === 'join') reject('join');
      if (lower === 'from') {
        if (seenFrom) reject('nhiều FROM');
        seenFrom = true;
        const short = tokens[i + 1] ?? '';
        const physical = mapTable(short, ctx);
        i++;
        // Bí danh: `FROM items AS i` / `FROM items i`; không có thì dùng chính tên ngắn (để `items.title` còn chạy).
        let alias = short;
        const nxt = tokens[i + 1];
        if (nxt && nxt.toLowerCase() === 'as') {
          alias = tokens[i + 2] ?? '';
          if (!IDENT.test(alias)) reject('bí danh không hợp lệ');
          i += 2;
        } else if (nxt && IDENT.test(nxt) && !NOT_ALIAS.has(nxt.toLowerCase())) {
          alias = nxt;
          i++;
        }
        // Sau bảng (+ bí danh) chỉ được là hết câu hoặc một mệnh đề — mọi thứ khác (',' JOIN NATURAL …) là nối bảng.
        const after = tokens[i + 1];
        if (after !== undefined && !CLAUSE_START.has(after.toLowerCase())) reject('FROM chỉ nhận một bảng');
        out.push(t,
          ctx.includeDeleted
            ? `${physical} AS ${alias}`
            : `(SELECT * FROM ${physical} WHERE deleted_at IS NULL) AS ${alias}`,
        );
        continue;
      }
      out.push(t);
    }
    if (!seenFrom) reject('SELECT không có FROM');
    return { sql: join(out), params, kind: 'select' };
  }

  if (head === 'insert') {
    // INSERT INTO t (c1, c2) VALUES (v1, v2)
    if (tokens[1]?.toLowerCase() !== 'into') reject('INSERT phải có INTO');
    const table = mapTable(tokens[2] ?? '', ctx);
    if (tokens[3] !== '(') reject('INSERT phải liệt kê cột');
    const closeCols = tokens.indexOf(')', 4);
    if (closeCols === -1) reject('danh sách cột không đóng');
    const cols = splitTop(tokens.slice(4, closeCols)).map((p) => p.join(''));
    if (tokens[closeCols + 1]?.toLowerCase() !== 'values' || tokens[closeCols + 2] !== '(') {
      reject('INSERT phải có VALUES (...)');
    }
    const valsTokens = tokens.slice(closeCols + 3);
    if (valsTokens[valsTokens.length - 1] !== ')') reject('VALUES không đóng');
    const vals = splitTop(valsTokens.slice(0, -1));
    if (vals.length !== cols.length) reject('số cột và số giá trị lệch nhau');
    if (vals.some((v) => v.includes('(') || v.includes(')'))) reject('biểu thức trong VALUES');
    const keepCols: string[] = [];
    const keepVals: string[] = [];
    const keepParams: unknown[] = [];
    let pIdx = 0;
    cols.forEach((c, i) => {
      if (!IDENT.test(c)) reject('tên cột không hợp lệ');
      const nParams = vals[i].filter((t) => t === '?').length;
      const mine = params.slice(pIdx, pIdx + nParams);
      pIdx += nParams;
      if (SYSTEM_COLS.has(c.toLowerCase())) return; // bỏ giá trị app truyền cho cột hệ thống
      keepCols.push(c);
      keepVals.push(join(vals[i]));
      keepParams.push(...mine);
    });
    if (!keepCols.some((c) => c.toLowerCase() === 'id')) reject('INSERT phải tự sinh id (UUID)');
    keepCols.push('tenant_id', 'created_at', 'updated_at');
    keepVals.push(lit(ctx.tenantId), lit(ctx.now), lit(ctx.now));
    return {
      sql: `INSERT INTO ${table} (${keepCols.join(', ')}) VALUES (${keepVals.join(', ')})`,
      params: keepParams,
      kind: 'insert',
    };
  }

  if (head === 'update') {
    // UPDATE t SET a = ?, b = 1 [WHERE ...]
    const table = mapTable(tokens[1] ?? '', ctx);
    if (tokens[2]?.toLowerCase() !== 'set') reject('UPDATE phải có SET');
    const whereIdx = tokens.findIndex((t) => t.toLowerCase() === 'where');
    const setTokens = tokens.slice(3, whereIdx === -1 ? undefined : whereIdx);
    const whereTokens = whereIdx === -1 ? [] : tokens.slice(whereIdx);
    const assigns = splitTop(setTokens);
    const keep: string[] = [];
    const keepParams: unknown[] = [];
    let pIdx = 0;
    for (const a of assigns) {
      if (a[1] !== '=' || !IDENT.test(a[0] ?? '')) reject('SET không hợp lệ');
      const n = a.filter((t) => t === '?').length;
      const mine = params.slice(pIdx, pIdx + n);
      pIdx += n;
      if (SYSTEM_COLS.has(a[0].toLowerCase())) continue;
      keep.push(join(a));
      keepParams.push(...mine);
    }
    keep.push(`updated_at = ${lit(ctx.now)}`);
    const whereParams = params.slice(pIdx);
    return {
      sql: `UPDATE ${table} SET ${keep.join(', ')}${liveWhere(whereTokens)}`,
      params: [...keepParams, ...whereParams],
      kind: 'update',
    };
  }

  if (head === 'delete') {
    // DELETE FROM t [WHERE ...] → xoá mềm
    if (tokens[1]?.toLowerCase() !== 'from') reject('DELETE phải có FROM');
    const table = mapTable(tokens[2] ?? '', ctx);
    const rest = tokens.slice(3);
    if (rest.length && rest[0].toLowerCase() !== 'where') reject('DELETE chỉ nhận WHERE');
    return {
      sql: `UPDATE ${table} SET deleted_at = ${lit(ctx.now)}, updated_at = ${lit(ctx.now)}${liveWhere(rest)}`,
      params,
      kind: 'delete',
    };
  }

  return reject('chỉ SELECT / INSERT / UPDATE / DELETE');
}
