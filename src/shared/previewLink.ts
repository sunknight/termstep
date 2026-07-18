// 工具文档（help.md）里链接的分类与路径解析（纯函数，前后端无依赖）。
//
// 设计见 docs/superpowers/specs/2026-07-18-preview-overlay-design.md。
// 链接类型由 href 形式自动判断，零新 markdown 语法：
//   - mailto:           → 系统（邮件客户端）
//   - http(s) .md/.txt  → 远程文档预览（fetch_md_preview）
//   - http(s) 其他      → 网页预览（iframe）
//   - 本地 .md/.txt     → 本地文档预览（相对工具 cwd 解析后走 fetch_md_preview）
//   - 本地其他后缀     → 暂不支持
//   - 其他 scheme       → 阻止（防 javascript:/data:）
//
// 文档后缀白名单与后端 tools.rs:allowed_md_extensions 对齐。

export const DOC_EXTENSIONS = ['md', 'markdown', 'txt'] as const;

export type LinkKind =
  | { kind: 'mailto' }
  | { kind: 'web'; url: string } // http(s) 网页
  | { kind: 'remoteDoc'; url: string } // http(s) 文档
  | { kind: 'localDoc'; path: string } // 本地文档（解析后绝对路径）
  | { kind: 'unsupported' } // 本地非文档后缀
  | { kind: 'blocked' }; // 其他 scheme（javascript:/data: 等）

/// 去掉 path 末尾的 #anchor / ?query，返回纯 path（用于后缀判断）。
function stripAnchorQuery(s: string): string {
  // 先切 # 再切 ?，顺序无所谓（两者都不影响后缀）
  const noHash = s.split('#')[0];
  return noHash.split('?')[0];
}

/// path/URL 是否以文档后缀结尾（大小写不敏感，忽略尾部 #/?）。
export function hasDocExtension(href: string): boolean {
  const p = stripAnchorQuery(href).toLowerCase();
  return DOC_EXTENSIONS.some((ext) => p.endsWith('.' + ext));
}

/// 后缀是否为 .txt（决定用 <pre> 还是 md.render）。
export function isTxtPath(href: string): boolean {
  return stripAnchorQuery(href).toLowerCase().endsWith('.txt');
}

/// 是否 http(s) 链接。
function isHttp(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/// 是否 mailto。
function isMailto(href: string): boolean {
  return /^mailto:/i.test(href);
}

/// 是否形如 scheme: 的链接（含字母 scheme 前缀）。
function hasScheme(href: string): boolean {
  // RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  return !!m;
}

/// 把相对路径基于 cwd 解析为绝对路径。约定：
///   - 绝对路径（/ 或盘符开头）原样返回
///   - ~ 开头原样返回（后端守卫会处理；极少见，文档不应放 home）
///   - 相对路径基于 cwd 拼接，规整 ./ 和多余的重复分隔符
///   - 无 cwd 且为相对路径：返回原样（后端会读到错误）
///
/// 不依赖 path 库（渲染端无 node path）；用简单字符串处理 + URL 自解析。
/// 注意：不做 `..` 上溯规整的严格规范化——后端 sensitive_path_reason 已挡敏感目录，
//        且 read_to_string 对越界路径只会自然失败。这里只做基础的 ./ 清理。
export function resolveDocPath(href: string, cwd: string | undefined): string {
  if (!href) return href;
  // 绝对路径（Unix / 开头，或 Windows 盘符）
  if (href.startsWith('/')) return href;
  if (/^[a-zA-Z]:[\\/]/.test(href)) return href;
  // home 简写原样（后端处理）
  if (href.startsWith('~')) return href;
  // file:// 原样（后端 is_local_path 会 strip 前缀）
  if (href.startsWith('file://')) return href;
  // 相对路径：基于 cwd
  if (!cwd) return href;
  // 拼接，规整多余分隔符与 ./（保留 ../ 让后端自然解析）
  const base = cwd.replace(/\/+$/, '');
  let p = href;
  // 若 href 以 ./ 开头，去掉前导 ./
  p = p.replace(/^\.\//, '');
  // 若 base 已是目录，直接拼
  let joined = base + '/' + p;
  // 规整连续 /
  joined = joined.replace(/\/{2,}/g, '/');
  return joined;
}

/// 主分类函数：根据 href（原始 markdown 链接 href）+ 工具 cwd，决定如何处理。
export function classifyLink(href: string, cwd: string | undefined): LinkKind {
  if (!href) return { kind: 'blocked' };
  if (isMailto(href)) return { kind: 'mailto' };
  if (isHttp(href)) {
    return hasDocExtension(href)
      ? { kind: 'remoteDoc', url: href }
      : { kind: 'web', url: href };
  }
  // file:// 视为本地路径（与后端 is_local_path 一致，后端会 strip 前缀读取）
  if (/^file:\/\//i.test(href)) {
    if (hasDocExtension(href)) {
      // file:// 已是绝对形式，不再 resolveDocPath（避免 cwd 干扰），原样传后端
      return { kind: 'localDoc', path: href };
    }
    return { kind: 'unsupported' };
  }
  // 非 http/mailto/file：若有其他 scheme（javascript:/data:/tel: 等）→ 阻止
  if (hasScheme(href)) return { kind: 'blocked' };
  // 本地路径
  if (hasDocExtension(href)) {
    return { kind: 'localDoc', path: resolveDocPath(href, cwd) };
  }
  return { kind: 'unsupported' };
}
