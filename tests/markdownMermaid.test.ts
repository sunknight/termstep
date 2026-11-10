import { describe, expect, it } from 'vitest';
import { md } from '../src/renderer/lib/markdown';

// ```mermaid 围栏的占位输出（真正渲染在浏览器端由 lib/mermaid.ts 完成，
// 这里只验证 fence 覆盖：占位结构、源码转义、不影响普通 fence 与 buttons）。

describe('markdown fence: mermaid 占位', () => {
  it('mermaid 围栏输出占位 wrapper，data-src 与 fallback 均含源码', () => {
    const html = md.render('```mermaid\nflowchart TD\n  A --> B\n```');
    expect(html).toContain('<div class="mermaid-wrap" data-src="flowchart TD');
    expect(html).toContain('<pre class="mermaid-fallback"><code>flowchart TD');
    expect(html).not.toContain('<svg'); // 渲染期才替换，fence 不产 SVG
  });

  it('源码中的 HTML/引号/箭头被转义（data-src 属性注入安全）', () => {
    const html = md.render('```mermaid\nA["x <b> & \\"q\\""] --> B\n```');
    expect(html).toContain('data-src="A[&quot;x &lt;b&gt; &amp; \\&quot;q\\&quot;&quot;] --&gt; B');
    expect(html).not.toContain('<b>');
  });

  it('info 首词大小写不敏感、可带尾随词', () => {
    expect(md.render('```Mermaid\ngraph TD\n```')).toContain('class="mermaid-wrap"');
    expect(md.render('```mermaid title=x\ngraph TD\n```')).toContain('class="mermaid-wrap"');
  });

  it('普通代码围栏不受影响', () => {
    const html = md.render('```text\nflowchart TD\n```');
    expect(html).toContain('<pre><code class="language-text">');
    expect(html).not.toContain('mermaid-wrap');
  });

  it('buttons / buttons-json 渲染不被 mermaid 分支抢占', () => {
    const html = md.render('```buttons\nls -la # 列目录\n```');
    expect(html).toContain('cmd-btn');
    expect(html).not.toContain('mermaid-wrap');
  });

  it('mermaid 源码按原样保留（缩进/换行原样，箭头被转义）', () => {
    const html = md.render('```mermaid\nstateDiagram-v2\n    [*] --> backlog: create\n```');
    expect(html).toContain('data-src="stateDiagram-v2\n    [*] --&gt; backlog: create\n"');
  });
});
