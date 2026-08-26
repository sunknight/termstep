import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Tool } from '../../shared/types';
import { buildGroupedView, UNGROUPED } from '../../shared/grouping';
import type { GroupSection } from '../../shared/grouping';
import {
  buildNewGroupsOrder,
  buildNewOrder,
  isNoopGroupTarget,
  isNoopTarget,
  resolveBeforeId,
  sameDropTarget,
  sameGroupDropTarget,
} from '../../shared/sidebarDrag';
import type { DropTarget, GroupDropTarget } from '../../shared/sidebarDrag';
import { UpdateChecker } from './UpdateChecker';
import { SettingsSection } from './SettingsSection';

const MIN_WIDTH = 140;
const MAX_WIDTH = 380;
const DEFAULT_WIDTH = 180;
const STORAGE_KEY = 'termstep:sidebar-width';
const COLLAPSED_KEY = 'termstep:sidebar-collapsed-groups';

export function Sidebar(props: {
  tools: Tool[];
  /** 分组展示顺序（来自 ScanResult.groups）。 */
  groups: string[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  /** 分组头拖拽排序：orderedGroups 为新的分组展示顺序（不含未分组）。 */
  onReorderGroups: (orderedGroups: string[]) => void;
  /** 跨分组移动：把工具移到 targetGroup（null=未分组），beforeId 为 null 时追加到分组末尾。 */
  onMove: (toolId: string, targetGroup: string | null, beforeId: string | null) => void;
  onNew: () => void;
  /** 收起整个侧栏（顶行 ‹ 按钮）。编辑/预览覆盖层盖住主区顶栏，折叠入口放
   *  侧栏顶行才能在覆盖层打开时保持可点。 */
  onCollapse: () => void;
  onExport: () => void;
  onImport: () => void;
  onHelp: () => void;
  onVersions: () => void;
  /** 打开着编辑器的工具（key=toolId）。行尾显示 ✏️ 标记。 */
  editingIds: Record<string, boolean>;
  floating?: boolean;
}) {
  const [width, setWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return v >= MIN_WIDTH && v <= MAX_WIDTH ? v : DEFAULT_WIDTH;
  });
  // 拖拽状态
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // dropTarget 的 ref 镜像：pointerup 回调在拖拽开始时闭包，读不到最新 state。
  const dropTargetRef = useRef<DropTarget | null>(null);
  useEffect(() => {
    dropTargetRef.current = dropTarget;
  }, [dropTarget]);
  // 工具列表 ul 的引用：拖拽时扫描其下所有 <li> 的几何位置来计算落点，
  // 避免依赖 elementFromPoint（会在 2px gap 上命中父容器，造成落点闪烁）。
  const listRef = useRef<HTMLUListElement>(null);
  // 自实现拖拽，用 pointer 事件而非 mouse 事件。关键原因：触控板「轻点来点按」抬起
  // 时 mouseup 经常不被 WebKit 派发（mousedown 与 mouseup 落在不同元素，或合成缺陷），
  // 导致 mouseup 监听永不触发 → 拖拽无法结束（mousemove 一直挂着，鼠标动一下就拖）。
  // pointerup 派发更可靠，配合 setPointerCapture 把指针锁到图标元素，move/up 稳定到达。
  // 阈值区分点击与拖拽：pointerdown→up 位移 < DRAG_THRESHOLD 当作点击（不拖），否则拖。
  const DRAG_THRESHOLD = 4;
  const dragStartRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const dragActiveRef = useRef(false); // 超过阈值、真正进入拖拽态

  // 分组头拖拽排序状态（与工具拖拽互斥：一次 pointer 流只激活一种）。
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const [groupDropTarget, setGroupDropTarget] = useState<GroupDropTarget | null>(null);
  // groupDropTarget 的 ref 镜像（同 dropTargetRef 的理由：pointerup 闭包读不到最新 state）。
  const groupDropTargetRef = useRef<GroupDropTarget | null>(null);
  useEffect(() => {
    groupDropTargetRef.current = groupDropTarget;
  }, [groupDropTarget]);
  const groupDragStartRef = useRef<{ group: string; x: number; y: number } | null>(null);
  const groupDragActiveRef = useRef(false);
  // 分组头拖动过阈值后，pointerup 随之派发的 click 不再触发折叠/展开。
  // pointerdown 时复位（新交互开始），防止某次拖拽后 click 未派发导致标志残留、
  // 下一次轻点被误吞。
  const suppressHeaderClickRef = useRef(false);

  // 分组折叠态：存「已折叠」的分组名集合。默认空 = 全展开。
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const arr = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
      return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set<string>();
    }
  });
  const toggleGroup = (name: string) => {
    if (props.floating) return; // 浮层恒展开
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(next)));
      return next;
    });
  };

  // 由 toolId 查所属分组名。未分组返回 null。
  const groupOf = (id: string): string | null => {
    const t = props.tools.find((x) => x.meta.id === id);
    return t?.meta.group ?? null;
  };

  const groupedView = useMemo(() => buildGroupedView(props.tools, props.groups), [props.tools, props.groups]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(width));
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
  }, [width]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (ev.clientX - startX)));
      setWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  /** 根据指针位置计算当前 drop target。
   *
   * 关键设计：相邻工具之间**只能有一个落点**。实现方式是扫描滚动列表里所有
   * 渲染出的 `<li>`（工具行 + 分组标题），把指针 Y 映射到「最近的相邻边界」，
   * 再按边界两侧的元素决定语义。这样：
   *  - 指针落在某工具行的上半 = 它的上边界 = 「插到此工具之前」。
   *  - 指针落在某工具行的下半 = 下一个元素的上边界（同组下一个工具 / 下个分组标题
   *    / 列表底）。同组下一个工具 → 「插到下一个工具之前」（=此工具之后，同一条线）；
   *    下一个是别的分组标题 → 「追加到本分组末尾」（此工具下沿线）。
   *  - 列表项之间 2px 的 gap 不再产生「无目标」空隙：因为它仍在某行的边界附近，
   *    取最近的边界即可。
   */
  const computeDropTarget = (ev: PointerEvent): DropTarget | null => {
    const list = listRef.current;
    if (!list) return null;
    const items = Array.from(list.querySelectorAll<HTMLLIElement>(':scope > li'));
    if (items.length === 0) return null;
    const y = ev.clientY;

    // 计算每个 <li> 的上边界 Y。把指针 Y 落到「最近的上边界」所属的元素上。
    // 同时记录其前一个兄弟（gap 边界归属判断要用）。
    type Item = { li: HTMLLIElement; top: number; key: string | null; group: string | null };
    const rows: Item[] = items.map((li) => {
      const top = li.getBoundingClientRect().top;
      return {
        li,
        top,
        key: li.getAttribute('data-key'),
        group: li.getAttribute('data-group'),
      };
    });

    // 找到指针 Y 落在哪一行（top <= y < 下一行 top）。若 y 超出最后一行底，算最后一行。
    let hit: Item | null = null;
    for (let i = 0; i < rows.length; i++) {
      const nextTop = i + 1 < rows.length ? rows[i + 1].top : Number.POSITIVE_INFINITY;
      if (y >= rows[i].top && y < nextTop) {
        hit = rows[i];
        break;
      }
    }
    if (!hit) {
      // y 在第一行之上 → 命中第一行
      hit = rows[0];
    }

    // 命中行的中点：上半归属「此行的上边界」，下半归属「下一行的上边界」。
    const rect = hit.li.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const useNext = y >= midY;

    const resolve = (item: Item): DropTarget | null => {
      if (item.key) {
        return { kind: 'before-tool', id: item.key };
      }
      if (item.group) {
        const groupName = item.group === UNGROUPED ? null : item.group;
        const isCollapsed = !props.floating && collapsed.has(item.group);
        if (!isCollapsed) {
          const section = groupedView.find((g) => g.name === item.group);
          if (section && section.tools.length > 0) {
            return { kind: 'before-tool', id: section.tools[0].meta.id };
          }
        }
        return { kind: 'append-group', group: groupName };
      }
      return null;
    };

    if (!useNext) {
      // 上半：归属此行上边界
      return resolve(hit);
    }

    // 下半：归属下一行的上边界。若没有下一行（最后一行）→ 该行若是工具且是本分组
    // 最后一个 → after-tool（下沿线，落到本分组底部）。
    const hitIdx = rows.indexOf(hit);
    const nextRow = hitIdx + 1 < rows.length ? rows[hitIdx + 1] : null;
    if (nextRow) {
      const resolved = resolve(nextRow);
      // 下一个是别的分组标题而当前是工具 → 改为「追加到当前工具所在分组末尾」，
      // 让线画在当前工具下方（分组真正的底部），而不是下个分组的首个工具上方。
      if (
        hit.key &&
        nextRow.group &&
        resolved?.kind === 'before-tool'
      ) {
        const hitGroup = groupOf(hit.key);
        const nextGroupName = nextRow.group === UNGROUPED ? null : nextRow.group;
        if (hitGroup !== nextGroupName) {
          return { kind: 'after-tool', id: hit.key };
        }
      }
      return resolved;
    }
    // 最后一行下半且是工具 → after-tool（列表底部）
    if (hit.key) {
      return { kind: 'after-tool', id: hit.key };
    }
    return resolve(hit);
  };

  /** 判断把 fromId 拖到 target 是否是 no-op（结果顺序/分组不变）。
   *  no-op 位置不显示落点指示。委托给 shared/isNoopTarget（可单测）。 */
  const isNoop = (fromId: string, target: DropTarget): boolean => isNoopTarget(props.tools, fromId, target);

  /** 执行释放：同组内走 onReorder，跨组走 onMove。 */
  const handleDrop = () => {
    const fromId = dragStartRef.current?.id ?? dragId;
    const target = dropTargetRef.current;
    if (!fromId || !target) {
      setDragId(null);
      setDropTarget(null);
      return;
    }

    // 无意义释放：放到自己身上或自身所在位置
    if (target.kind === 'before-tool' && target.id === fromId) {
      setDragId(null);
      setDropTarget(null);
      return;
    }
    if (target.kind === 'after-tool' && target.id === fromId) {
      setDragId(null);
      setDropTarget(null);
      return;
    }

    const targetGroup = target.kind === 'before-tool' || target.kind === 'after-tool' ? groupOf(target.id) : target.group;
    const fromGroup = groupOf(fromId);

    if (fromGroup === targetGroup) {
      const newOrder = buildNewOrder(props.tools, fromId, target);
      const currentOrder = props.tools.map((t) => t.meta.id);
      if (JSON.stringify(newOrder) !== JSON.stringify(currentOrder)) {
        props.onReorder(newOrder);
      }
    } else {
      const beforeId = resolveBeforeId(props.tools, target);
      props.onMove(fromId, targetGroup, beforeId);
    }

    setDragId(null);
    setDropTarget(null);
  };

  // ── 分组头拖拽排序 ────────────────────────────────────────────────────────
  // displayOrder = 当前展示的分组名序列（不含未分组，未分组恒末尾不参与排序）。
  // 拖拽期间数据不变，每次现算即最新。
  const displayGroupOrder = () => groupedView.filter((g) => !g.isUngrouped).map((g) => g.name);

  /** 分组拖拽时按指针位置计算落点。每个分组头**整行**只有一个落点（before，
   *  指示线画在头上沿）——不再提供分组头下半的 after 落点：它视觉上悬在
   *  「分组名与组内第一个工具之间」，折叠态下更是夹在两个分组名之间，歧义大。
   *  「移到最后」由列表末尾的 group-drop-zone 放置区承担（after 最后一个
   *  普通分组）。未分组头与工具行都不是落点；行间细缝按 ±TOLERANCE 归属
   *  （半缝归上一行、半缝归下一行）。 */
  const computeGroupDropTarget = (ev: PointerEvent): GroupDropTarget | null => {
    const list = listRef.current;
    if (!list) return null;
    const headers = Array.from(list.querySelectorAll<HTMLLIElement>(':scope > li.group-header'));
    if (headers.length === 0) return null;
    const y = ev.clientY;
    const TOLERANCE = 7;

    const normalNames = groupedView.filter((g) => !g.isUngrouped).map((g) => g.name);
    const last = normalNames[normalNames.length - 1];
    const zone = list.querySelector<HTMLLIElement>(':scope > li.group-drop-zone');

    type Row = { li: HTMLLIElement; target: GroupDropTarget };
    const rows: Row[] = [];
    for (const li of headers) {
      const name = li.getAttribute('data-group') ?? '';
      if (!name || name === UNGROUPED) continue; // 未分组头不是落点
      rows.push({ li, target: { group: name, place: 'before' } });
    }
    if (zone && last) rows.push({ li: zone, target: { group: last, place: 'after' } });

    for (const r of rows) {
      const rect = r.li.getBoundingClientRect();
      if (y >= rect.top - TOLERANCE && y <= rect.bottom + TOLERANCE) return r.target;
    }
    return null;
  };

  /** 分组拖拽释放：算新分组序，与当前不同才上抛（no-op 已在 move 中过滤，
   *  这里再兜底比较一次）。 */
  const handleGroupDrop = () => {
    const from = groupDragStartRef.current?.group ?? dragGroup;
    const target = groupDropTargetRef.current;
    if (from && target) {
      const current = displayGroupOrder();
      const newOrder = buildNewGroupsOrder(current, from, target);
      if (JSON.stringify(newOrder) !== JSON.stringify(current)) {
        props.onReorderGroups(newOrder);
      }
    }
    setDragGroup(null);
    setGroupDropTarget(null);
  };

  const renderToolRow = (t: Tool) => {
    const id = t.meta.id;
    const isTopTarget = dropTarget?.kind === 'before-tool' && dropTarget.id === id;
    // 下沿指示线只在「分组真正的最底部」显示（after-tool 且其后没有同组工具）。
    // 组内连续工具之间不画下沿线 —— 那个空隙在视觉上归属「下一个工具的上沿」，
    // 在同一处画两条线会让人感觉有两个落点。
    const nextId = (() => {
      const idx = props.tools.findIndex((x) => x.meta.id === id);
      return idx >= 0 && idx < props.tools.length - 1 ? props.tools[idx + 1].meta.id : null;
    })();
    const isLastInGroup = nextId === null || groupOf(nextId) !== groupOf(id);
    const isBottomTarget = dropTarget?.kind === 'after-tool' && dropTarget.id === id && isLastInGroup;
    const cls = [
      id === props.activeId ? 'active' : '',
      dragId === id ? 'dragging' : '',
      isTopTarget ? 'drag-over' : '',
      isBottomTarget ? 'drag-over-bottom' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <li
        key={id}
        data-key={id}
        className={cls}
        title={props.floating ? undefined : '拖动图标以排序'}
        // 整行（含 padding 上下空白）pointerdown 即选中。不用 click——触控板「轻点
        // 来点按」抬起时手指易横向滑动几像素，使 mousedown 与 mouseup 落在不同
        // 元素，浏览器不合成 click → 轻点失败。pointerdown/mousedown 稳定触发，
        // 不受抬手滑动影响，故用它选中，且覆盖整个 li（包括文字之外的空白）。
        // 用 pointer 而非 mouse，是为了和图标手柄用同一事件流——这样图标手柄的
        // stopPropagation 才能阻止冒泡到这里（pointer 与 mouse 是两条独立流）。
        // 展开态的图标手柄 stopPropagation 阻止选中（图标仅拖拽）；折叠态图标不
        // 绑 handler，pointerdown 冒泡到这里选中。
        onPointerDown={(e) => {
          if (e.button !== 0) return; // 仅左键
          props.onSelect(id);
        }}
      >
        {/* 图标：
            - 展开态：仅作拖拽手柄，pointerdown stopPropagation 阻止冒泡到 <li>
              （否则会选中），轻点图标不选中。位移超过阈值才算拖拽。
            - 折叠态（浮层）：不可拖拽，不绑 handler，pointerdown 冒泡到 <li> 选中。
            拖拽用 pointer 事件而非 mouse：触控板轻点的 mouseup 经常不派发，会导致
            拖拽无法结束（见组件上方注释）。用 setPointerCapture 把后续 move/up 锁
            定到本元素，确保 pointerup 稳定到达、拖拽可靠结束。 */}
        <span
          className={'icon' + (props.floating ? '' : ' drag-handle')}
          onPointerDown={
            props.floating
              ? undefined
              : (e) => {
                  if (e.button !== 0) return; // 仅左键
                  e.stopPropagation(); // 图标是拖拽手柄，不让 <li> 的选中冒泡上来
                  // 捕获元素引用：pointerdown 事件结束后 e.currentTarget 会变 null，
                  // 后续 pointerup 回调里不能再从 e 上读，必须用闭包里的 handle。
                  const handle = e.currentTarget;
                  const pointerId = e.pointerId;
                  dragStartRef.current = { id, x: e.clientX, y: e.clientY };
                  dragActiveRef.current = false;
                  // 锁定指针：后续 move/up/cancel 都派发给本元素，即使指针移出图标。
                  handle.setPointerCapture(pointerId);
                  const onMove = (ev: PointerEvent) => {
                    const s = dragStartRef.current;
                    if (!s) return;
                    if (!dragActiveRef.current) {
                      const dx = ev.clientX - s.x;
                      const dy = ev.clientY - s.y;
                      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return; // 阈值内不算拖拽
                      dragActiveRef.current = true; // 超过阈值 → 进入拖拽态
                      setDragId(s.id);
                    }
                    // 拖拽中：扫描列表 <li> 的几何位置计算落点；落点是 no-op
                    // （拖到自己原位）时不显示指示线。
                    let next = computeDropTarget(ev);
                    if (next && isNoop(s.id, next)) next = null;
                    const finalNext = next;
                    setDropTarget((cur) => (sameDropTarget(cur, finalNext) ? cur : finalNext));
                  };
                  const finish = () => {
                    handle.removeEventListener('pointermove', onMove);
                    handle.removeEventListener('pointerup', finish);
                    handle.removeEventListener('pointercancel', finish);
                    try {
                      handle.releasePointerCapture(pointerId);
                    } catch {
                      // pointerId 已失效（如元素已卸载）——忽略
                    }
                    if (dragActiveRef.current) {
                      handleDrop(); // 真拖拽 → 执行 reorder / move
                    }
                    dragStartRef.current = null;
                    dragActiveRef.current = false;
                    setDragId(null);
                    setDropTarget(null);
                  };
                  handle.addEventListener('pointermove', onMove);
                  handle.addEventListener('pointerup', finish);
                  handle.addEventListener('pointercancel', finish);
                }
          }
        >
          {t.meta.icon}
        </span>
        <span className="name">{t.meta.name}</span>
        {props.editingIds[id] && (
          <span className="edit-mark" title="编辑中" aria-label="编辑中">✏️</span>
        )}
      </li>
    );
  };

  return (
    <nav className="sidebar" style={{ width: `${width}px`, flex: `0 0 ${width}px` }}>
      {/* 顶部顶栏：与中、右列顶栏等高，固定不滚动。展开态放「‹ 收起」+「新建工具」。
          折叠态（浮层）不渲染——浮层只用于选中工具/跑命令，顶栏无意义且占高度。 */}
      {!props.floating && (
        <div className="sidebar-top">
          <button
            className="sidebar-collapse"
            title="收起工具列表"
            aria-label="收起工具列表"
            onClick={props.onCollapse}
          >
            ‹
          </button>
          <button className="new-tool" onClick={props.onNew}>+ 新建工具</button>
        </div>
      )}
      {/* 中间工具列表：唯一可滚动区域。flex:1 + min-height:0 保证在固定顶/底之间滚动。 */}
      <ul className="sidebar-list" ref={listRef}>
        {(() => {
          // 只有一个非空 bucket（或全未分组）→ 平铺渲染，不画分组头（向后兼容老数据）
          const nonEmpty = groupedView.filter((g) => g.tools.length > 0);
          const flat = nonEmpty.length <= 1;
          if (flat) {
            return groupedView.flatMap((g) => g.tools).map((t) => renderToolRow(t));
          }
          // 分组拖拽排序的落点指示：分组头只有上沿一个落点（before），「移到最后」
          // 由普通分组之后的 group-drop-zone 放置区承担（与工具拖拽的 isGroupTarget
          // 互斥：两种拖拽不会同时激活）。
          const renderSection = (g: GroupSection) => {
            // 空未分组不渲染（buildGroupedView 已保证，双保险）
            if (g.isUngrouped && g.tools.length === 0) return null;
            const isCollapsed = !props.floating && collapsed.has(g.name);
            const isGroupTarget = dropTarget?.kind === 'append-group' && dropTarget.group === (g.isUngrouped ? null : g.name);
            const isGroupDragTop =
              dragGroup !== null && groupDropTarget?.group === g.name && groupDropTarget.place === 'before';
            const headerCls = [
              'group-header',
              dragGroup === g.name ? 'dragging' : '',
              isGroupDragTop ? 'group-drag-over' : '',
              isGroupTarget ? 'drag-over-bottom' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <Fragment key={g.name}>
                <li
                  className={headerCls}
                  data-group={g.name}
                  onClick={() => {
                    // 分组头拖动过阈值后随之派发的 click 不触发折叠（suppressHeaderClickRef
                    // 在 pointerdown 复位，轻点不受影响）。
                    if (suppressHeaderClickRef.current) {
                      suppressHeaderClickRef.current = false;
                      return;
                    }
                    toggleGroup(g.name);
                  }}
                  title={props.floating || g.isUngrouped ? undefined : '点击折叠/展开，拖动调整分组顺序'}
                  // 分组头整行可拖（非浮层、非未分组）：轻点 = 折叠 toggle（click 路径），
                  // 按住拖动超阈值 = 拖拽分组排序。与工具行图标手柄同一套 pointer 事件
                  // 模式（setPointerCapture 保证 pointerup 稳定到达，规避触控板轻点
                  // mouseup 不派发的坑）。
                  onPointerDown={
                    props.floating || g.isUngrouped
                      ? undefined
                      : (e) => {
                          if (e.button !== 0) return; // 仅左键
                          // 捕获元素引用：pointerdown 事件结束后 e.currentTarget 会变 null，
                          // 后续 pointerup 回调里不能再从 e 上读，必须用闭包里的 handle。
                          const handle = e.currentTarget;
                          const pointerId = e.pointerId;
                          suppressHeaderClickRef.current = false;
                          groupDragStartRef.current = { group: g.name, x: e.clientX, y: e.clientY };
                          groupDragActiveRef.current = false;
                          // 锁定指针：后续 move/up/cancel 都派发给本元素，即使指针移出分组头。
                          handle.setPointerCapture(pointerId);
                          const onMove = (ev: PointerEvent) => {
                            const s = groupDragStartRef.current;
                            if (!s) return;
                            if (!groupDragActiveRef.current) {
                              const dx = ev.clientX - s.x;
                              const dy = ev.clientY - s.y;
                              if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return; // 阈值内不算拖拽
                              groupDragActiveRef.current = true; // 超过阈值 → 进入拖拽态
                              suppressHeaderClickRef.current = true; // 松手后的 click 不再触发折叠
                              setDragGroup(s.group);
                            }
                            // 拖拽中：扫描分组头 <li> 的几何位置计算落点；no-op
                            // （拖到原位/相邻位）不显示指示线。
                            let next = computeGroupDropTarget(ev);
                            if (next && isNoopGroupTarget(displayGroupOrder(), s.group, next)) next = null;
                            const finalNext = next;
                            setGroupDropTarget((cur) => (sameGroupDropTarget(cur, finalNext) ? cur : finalNext));
                          };
                          const finish = () => {
                            handle.removeEventListener('pointermove', onMove);
                            handle.removeEventListener('pointerup', finish);
                            handle.removeEventListener('pointercancel', finish);
                            try {
                              handle.releasePointerCapture(pointerId);
                            } catch {
                              // pointerId 已失效（如元素已卸载）——忽略
                            }
                            if (groupDragActiveRef.current) {
                              handleGroupDrop(); // 真拖拽 → 重排分组顺序
                            }
                            groupDragStartRef.current = null;
                            groupDragActiveRef.current = false;
                            setDragGroup(null);
                            setGroupDropTarget(null);
                          };
                          handle.addEventListener('pointermove', onMove);
                          handle.addEventListener('pointerup', finish);
                          handle.addEventListener('pointercancel', finish);
                        }
                  }
                >
                  <span className="caret" aria-hidden>
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                  <span className="group-name">{g.name}</span>
                  <span className="group-count">{g.tools.length}</span>
                </li>
                {!isCollapsed && g.tools.map((t) => renderToolRow(t))}
              </Fragment>
            );
          };

          // 普通分组 → 「移到最后」放置区 → 未分组（恒末尾）。
          // 放置区**常驻**渲染（不可见、零占位：height/margin/padding 全零），
          // 拖拽开始/结束 DOM 恒定——条件渲染会因 flex gap 与 padding 撑开空白。
          // 位置在最后一个普通分组之后：有未分组时视觉上即「未分组上方」。
          const normal = groupedView.filter((g) => !g.isUngrouped);
          const ungrouped = groupedView.find((g) => g.isUngrouped) ?? null;
          const zoneActive = groupDropTarget?.place === 'after';
          return (
            <>
              {normal.map((g) => renderSection(g))}
              <li className={`group-drop-zone${zoneActive ? ' active' : ''}`} aria-hidden />
              {ungrouped && renderSection(ungrouped)}
            </>
          );
        })()}
      </ul>
      {!props.floating && (
        <>
          <div className="sidebar-bottom">
            <UpdateChecker />
            <SettingsSection
              onImport={props.onImport}
              onExport={props.onExport}
              onHelp={props.onHelp}
              onVersions={props.onVersions}
            />
          </div>
          <div className="sidebar-resizer" onMouseDown={startDrag} title="拖动调整宽度" />
        </>
      )}
    </nav>
  );
}
