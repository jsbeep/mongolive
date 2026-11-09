// 왼쪽 사이드바 — 세 단계(useSidebar): 완전 접힘 / 아이콘 레일 / 전체.
//   전체: [ML 이름] · 쿼리 기록(Query)·참조(References)·북마크(Bookmarks) 패널 / 집계(아직 자리만) · ── · DB/컬렉션 트리
//   레일: 아이콘만. 아무 아이콘이나 누르면 전체로 펼친다. 맨 아래 = 설정 · 로그아웃 · 완전히 접기
//   전체 맨 아래: 설정 · 로그아웃(상태바는 '지금 상태'만, 앱·계정은 여기 — 완전히 접혀도 Ctrl+K 명령으로)
//   접힘: 화면 왼쪽 끝에 당김 핸들(아이폰 PiP를 옆으로 치워 둔 모양) — 늘 얇게 보이고 마우스가 다가가면 커진다.
//         누르면 접기 전 단계로, 오른쪽으로 끌면 끄는 만큼 펼친다.
// ML 버튼: 평소엔 ML, 올리면 무엇이 될지(전체 → 접기 아이콘, 레일 → 펼치기 아이콘).
// 너비: 오른쪽 가장자리를 끌면 너비에 따라 단계가 바뀐다(접힘 < 28px ≤ 레일 < 170px ≤ 전체). 더블클릭 = 기본 너비.
// 좁은 화면(<1024px)에선 레일까지만 붙고, 전체는 컬럼 위에 떠서 열린다(바깥 클릭·Esc → 레일).
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { Bookmark, ChevronRight, ChevronsLeft, Database, Link, LogOut, PanelLeftClose, PanelLeftOpen, Search, Settings, Workflow, X, type LucideIcon } from 'lucide-react';
import type { CollectionSummary, DatabaseSummary, MutationRequest } from '../../types/explorer';
import { clampFullWidth, FULL_DEFAULT, RAIL_WIDTH, snapMode, type SidebarMode, type SidebarState } from '../../hooks/useSidebar';
import { DatabaseTree } from './DatabaseTree';
import { useAuth } from '../auth/AuthGate';
import { cn } from '../../utils/cn';

// 사이드바와 컬럼 사이 틈 — 끌기 손잡이가 이 틈에 놓인다
const GAP = 8;
const SPRING = { type: 'spring', stiffness: 420, damping: 40 } as const;

interface SidebarProps {
  sidebar: SidebarState;
  databases: DatabaseSummary[];
  activeDatabase: string | null;
  activeCollection: string | null;
  collections: CollectionSummary[];
  onSelectDatabase: (name: string) => Promise<void>;
  onOpenCollection: (database: string, name: string, label: string) => Promise<void>;
  onMutate: (op: MutationRequest) => Promise<unknown>;
  // 떠 있는 패널(누른 버튼 옆) — Query = 쿼리 기록, References = 선언한 참조 전체, Bookmarks = 북마크. 한 번에 하나만.
  // canQuery가 false면(Mock) Query만 흐리게
  // Aggregation은 떠 있는 패널이 아니라 컬럼 전환(문서 목록 ⇄ 파이프라인) — 켜져 있는지는 aggregationOpen
  panels: { open: SidebarPanelKind | null; aggregationOpen: boolean; canQuery: boolean; onToggle: (kind: SidebarPanelKind, anchor: DOMRect) => void };
  // 맨 아래(VSCode처럼 앱·계정은 사이드바 아래) — 설정 창, 로그아웃(로그인 모드일 때만)
  onOpenSettings: () => void;
}

export type SidebarPanelKind = 'history' | 'references' | 'bookmarks' | 'aggregation';

type TreeProps = Omit<SidebarProps, 'sidebar'>;

// 아직 없는 기능 — 눌러도 아무 일이 없으니 흐리게 + 'Soon' 표시
const SOON_ITEMS: { icon: LucideIcon; label: string }[] = [];
const QUERY_TIP = 'Query history — run a past query on this collection';
const QUERY_TIP_MOCK = 'Query history — needs a server connection (not in demo mode)';
const REFS_TIP = 'References — everything you declared, across databases';
const BOOKMARKS_TIP = 'Bookmarks — places you saved from a column’s icon';

// 패널을 여는 사이드바 버튼들(전체·레일 공통)
// 켜진 Aggregation은 X를 달아 '다시 누르면 닫힌다'를 보인다
const AGGREGATION_CLOSE_TIP = 'Close Aggregation — back to the documents';

const PANEL_ITEMS: { kind: SidebarPanelKind; icon: LucideIcon; label: string; tip: (canQuery: boolean) => string; needsQuery: boolean }[] = [
  { kind: 'history', icon: Search, label: 'Query', tip: (ok) => (ok ? QUERY_TIP : QUERY_TIP_MOCK), needsQuery: true },
  { kind: 'aggregation', icon: Workflow, label: 'Aggregation', tip: (ok) => (ok ? 'Aggregation — build a pipeline on this collection (click again for documents)' : 'Aggregation — needs a server connection (not in demo mode)'), needsQuery: true },
  { kind: 'references', icon: Link, label: 'References', tip: () => REFS_TIP, needsQuery: false },
  { kind: 'bookmarks', icon: Bookmark, label: 'Bookmarks', tip: () => BOOKMARKS_TIP, needsQuery: false },
];

const styles = {
  // 컬럼 패널과 같은 카드 모양
  card: 'relative flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200/60 bg-white/90 shadow-panel',
  cardFloating: 'relative flex h-full flex-col overflow-hidden rounded-2xl bg-white shadow-elevated ring-1 ring-slate-200/70',
  // 오른쪽 컬럼 패널의 브레드크럼 줄(m-3, h-12)과 같은 높이
  brand: 'mx-3 mt-3 flex h-12 shrink-0 items-center gap-2.5',
  brandRail: 'mt-3 flex h-12 shrink-0 items-center justify-center',
  // ML 버튼 — 올리면(포커스) 아이콘으로 바뀐다
  mlButton:
    'group relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] border border-emerald-200 bg-emerald-50 text-sm font-bold text-emerald-700 transition-colors hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30',
  brandName: 'min-w-0 flex-1',
  brandTitle: 'truncate text-sm font-semibold tracking-tight text-slate-900',
  brandSub: 'truncate text-[11px] text-slate-500',
  nav: 'flex shrink-0 flex-col gap-0.5 px-2 pt-3',
  // 아직 없는 기능 — 누를 수 없음(aria-disabled: disabled면 툴팁 이벤트도 막혀서)
  navItem: 'flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px] text-slate-400',
  // 켜짐/꺼짐/흐림은 셋 중 하나만 붙인다(cn은 겹치는 클래스를 정리해 주지 않는다)
  navButton: 'flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors',
  navButtonIdle: 'text-slate-600 hover:bg-slate-100 hover:text-slate-800',
  navButtonActive: 'bg-emerald-50 text-emerald-700',
  navButtonDisabled: 'cursor-default text-slate-600 opacity-50',
  railBtnActive: 'inline-flex h-9 w-9 items-center justify-center rounded-md bg-emerald-50 text-emerald-700 transition-colors',
  soon: 'ml-auto rounded px-1.5 py-px text-[10px] font-medium text-slate-400 ring-1 ring-slate-200',
  divider: 'mx-3 my-2.5 h-px shrink-0 bg-slate-100',
  footer: 'flex shrink-0 items-center gap-1 border-t border-slate-100 px-2 py-2',
  railList: 'flex flex-col items-center gap-1',
  railBtn: 'inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800',
  railBtnSoon: 'inline-flex h-9 w-9 cursor-default items-center justify-center rounded-md text-slate-300',
  // 끌기 손잡이 — 틈(GAP) 전체가 잡히고, 가운데 선은 올리거나 끄는 동안만 보인다
  handle: 'group absolute inset-y-0 z-10 flex cursor-col-resize touch-none justify-center outline-none',
  handleLineIdle: 'w-[2px] rounded-full bg-transparent transition-colors group-hover:bg-emerald-300 group-focus-visible:bg-emerald-400',
  handleLineActive: 'w-[2px] rounded-full bg-emerald-400',
} as const;

// ── 내용 ────────────────────────────────────────────────────────────────────

function MlButton({ hoverIcon: HoverIcon, label, onClick }: { hoverIcon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button type="button" className={styles.mlButton} onClick={onClick} aria-label={label} data-tt={label}>
      <span className="group-hover:hidden group-focus-visible:hidden" aria-hidden="true">ML</span>
      <HoverIcon size={16} className="hidden group-hover:block group-focus-visible:block" aria-hidden="true" />
    </button>
  );
}

function FullContent({ onCollapseToRail, ...tree }: TreeProps & { onCollapseToRail: () => void }) {
  const auth = useAuth();
  return (
    <>
      <div className={styles.brand}>
        <MlButton hoverIcon={PanelLeftClose} label="Collapse to icons" onClick={onCollapseToRail} />
        <div className={styles.brandName}>
          <p className={styles.brandTitle}>MongoLive</p>
          <p className={styles.brandSub}>MongoDB Live DashBoard</p>
        </div>
      </div>
      <nav className={styles.nav} aria-label="Tools">
        {PANEL_ITEMS.map(({ kind, icon: Icon, label, tip, needsQuery }) => {
          const enabled = !needsQuery || tree.panels.canQuery;
          const open = kind === 'aggregation' ? tree.panels.aggregationOpen : tree.panels.open === kind;
          const closable = kind === 'aggregation' && open;
          return (
            <button
              key={kind}
              type="button"
              data-sidebar-panel-toggle=""
              aria-expanded={open}
              aria-disabled={!enabled}
              className={cn(styles.navButton, !enabled ? styles.navButtonDisabled : open ? styles.navButtonActive : styles.navButtonIdle, closable && 'group hover:bg-emerald-100/70')}
              data-tt={closable ? AGGREGATION_CLOSE_TIP : tip(tree.panels.canQuery)}
              onClick={(e) => enabled && tree.panels.onToggle(kind, e.currentTarget.getBoundingClientRect())}
            >
              <Icon size={15} />
              <span>{label}</span>
              {closable && <X size={13} className="ml-auto shrink-0 opacity-60 transition-opacity group-hover:opacity-100" />}
            </button>
          );
        })}
        {SOON_ITEMS.map(({ icon: Icon, label }) => (
          <div key={label} className={styles.navItem} role="button" aria-disabled="true" data-tt={`${label} — coming soon`}>
            <Icon size={15} />
            <span>{label}</span>
            <span className={styles.soon}>Soon</span>
          </div>
        ))}
      </nav>
      <div className={styles.divider} />
      <DatabaseTree
        databases={tree.databases}
        activeDatabase={tree.activeDatabase}
        activeCollection={tree.activeCollection}
        collections={tree.collections}
        onSelectDatabase={tree.onSelectDatabase}
        onOpenCollection={tree.onOpenCollection}
        onMutate={tree.onMutate}
      />
      <div className={styles.footer}>
        <button type="button" className={cn(styles.navButton, styles.navButtonIdle, 'flex-1')} onClick={tree.onOpenSettings} data-tt="Settings">
          <Settings size={15} />
          <span>Settings</span>
        </button>
        {auth.canLogout && (
          <button type="button" className={styles.railBtn} onClick={() => void auth.logout()} aria-label="Sign out" data-tt="Sign out of this browser">
            <LogOut size={15} />
          </button>
        )}
      </div>
    </>
  );
}

function RailContent({ onExpand, onHide, panels, onOpenSettings }: { onExpand: () => void; onHide: () => void; panels: SidebarProps['panels']; onOpenSettings: () => void }) {
  const auth = useAuth();
  return (
    <>
      <div className={styles.brandRail}>
        <MlButton hoverIcon={PanelLeftOpen} label="Expand sidebar" onClick={onExpand} />
      </div>
      <nav className={`${styles.railList} pt-3`} aria-label="Tools">
        {PANEL_ITEMS.map(({ kind, icon: Icon, label, tip, needsQuery }) => {
          const enabled = !needsQuery || panels.canQuery;
          const open = kind === 'aggregation' ? panels.aggregationOpen : panels.open === kind;
          const closable = kind === 'aggregation' && open;
          return (
            <button
              key={kind}
              type="button"
              data-sidebar-panel-toggle=""
              aria-label={label}
              aria-expanded={open}
              aria-disabled={!enabled}
              className={cn(!enabled ? styles.railBtnSoon : open ? styles.railBtnActive : styles.railBtn, closable && 'group relative hover:bg-emerald-100/70')}
              data-tt={closable ? AGGREGATION_CLOSE_TIP : tip(panels.canQuery)}
              onClick={(e) => enabled && panels.onToggle(kind, e.currentTarget.getBoundingClientRect())}
            >
              {/* 켜진 Aggregation — 올리면 아이콘이 X로 바뀐다 */}
              <Icon size={16} className={closable ? 'group-hover:hidden' : undefined} />
              {closable && <X size={16} className="hidden group-hover:block" />}
            </button>
          );
        })}
        {SOON_ITEMS.map(({ icon: Icon, label }) => (
          <div key={label} className={styles.railBtnSoon} role="button" aria-disabled="true" aria-label={label} data-tt={`${label} — coming soon`}>
            <Icon size={16} />
          </div>
        ))}
      </nav>
      <div className="mx-auto my-2.5 h-px w-6 shrink-0 bg-slate-100" />
      <div className={styles.railList}>
        <button type="button" className={styles.railBtn} onClick={onExpand} aria-label="Databases" data-tt="Databases">
          <Database size={16} />
        </button>
      </div>
      <div className="flex-1" />
      <div className={`${styles.railList} pb-3`}>
        <button type="button" className={styles.railBtn} onClick={onOpenSettings} aria-label="Settings" data-tt="Settings">
          <Settings size={16} />
        </button>
        {auth.canLogout && (
          <button type="button" className={styles.railBtn} onClick={() => void auth.logout()} aria-label="Sign out" data-tt="Sign out of this browser">
            <LogOut size={16} />
          </button>
        )}
        <div className="my-1 h-px w-6 bg-slate-100" />
        <button type="button" className={styles.railBtn} onClick={onHide} aria-label="Hide sidebar" data-tt="Hide sidebar — pull it back from the left edge">
          <ChevronsLeft size={16} />
        </button>
      </div>
    </>
  );
}

// ── 끌기 ────────────────────────────────────────────────────────────────────

// 손잡이를 끄는 동안의 '날 것' 너비. start(붙어 있던 너비)로 시작한다.
// 4px 넘게 움직여야 끌기로 친다 — 그 전에 놓으면 onClick(당김 핸들의 '누르기')
function useDrag(onCommit: (raw: number) => void, onClick?: () => void) {
  const dragRef = useRef<{ startX: number; startWidth: number; pointerId: number; moved: boolean } | null>(null);
  const [raw, setRaw] = useState<number | null>(null);
  const dragging = raw !== null;

  useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  const start = (startWidth: number) => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth, pointerId: e.pointerId, moved: false };
  };
  const handlers = {
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const dx = e.clientX - drag.startX;
      if (!drag.moved && Math.abs(dx) < 4) return;
      drag.moved = true;
      setRaw(drag.startWidth + dx);
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      setRaw(null);
      if (drag.moved) onCommit(drag.startWidth + (e.clientX - drag.startX));
      else onClick?.();
    },
    onPointerCancel: () => {
      dragRef.current = null;
      setRaw(null);
    },
  };
  return { raw, dragging, start, handlers };
}

// ── 당김 핸들(완전 접힘) ─────────────────────────────────────────────────────

function PullHandle({ drag, onRestore }: { drag: ReturnType<typeof useDrag>; onRestore: () => void }) {
  // 마우스가 화면 왼쪽 끝 가까이 오면 커진다(끄는 중에도)
  const [near, setNear] = useState(false);
  useEffect(() => {
    let frame = 0;
    const onMove = (e: globalThis.PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setNear(e.clientX < 56));
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
    };
  }, []);
  const big = near || drag.dragging;

  return (
    // 보이는 탭보다 넓은 영역(w-6)이 눌린다 — 얇은 탭만으론 터치로 잡기 어려워서
    <button
      type="button"
      className="fixed left-0 top-1/2 z-[95] flex h-28 w-6 -translate-y-1/2 touch-none items-center outline-none"
      aria-label="Show sidebar"
      data-tt={drag.dragging ? undefined : 'Show sidebar — or drag to pull it out'}
      onPointerDown={drag.start(0)}
      {...drag.handlers}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onRestore();
        }
      }}
    >
      <m.span
        className="flex items-center justify-center overflow-hidden rounded-r-xl bg-white text-slate-500 shadow-elevated ring-1 ring-slate-200"
        initial={false}
        animate={big ? { width: 20, height: 72, opacity: 1 } : { width: 5, height: 48, opacity: 0.85 }}
        transition={SPRING}
      >
        {big && <ChevronRight size={14} aria-hidden="true" />}
      </m.span>
    </button>
  );
}

// ── 사이드바 ──────────────────────────────────────────────────────────────────

const dockedWidthOf = (mode: SidebarMode, fullWidth: number) => (mode === 'full' ? fullWidth : mode === 'rail' ? RAIL_WIDTH : 0);

export function Sidebar({ sidebar, ...tree }: SidebarProps) {
  const { mode, isOverlay, width } = sidebar;
  const toRail = () => sidebar.setMode('rail');
  const toFull = () => sidebar.setMode('full');
  const hide = () => sidebar.setMode('collapsed');

  // 붙어 있는 가장자리 끌기 / 접혔을 때 당김 핸들 끌기 — 둘 다 놓으면 너비로 단계를 정한다
  const edgeDrag = useDrag(sidebar.commitDrag);
  const pullDrag = useDrag(sidebar.commitDrag, sidebar.restore);
  const rawWidth = edgeDrag.raw ?? pullDrag.raw;
  const dragging = rawWidth !== null;

  // 붙어 있는 부분의 단계 — 끄는 동안엔 미리보기. 좁은 화면에선 '전체'도 붙는 건 레일까지(전체는 위에 뜬다)
  const shownMode: SidebarMode = rawWidth !== null ? snapMode(rawWidth) : mode;
  const dockedMode: SidebarMode = isOverlay && shownMode === 'full' ? 'rail' : shownMode;
  const fullWidth = rawWidth !== null ? clampFullWidth(rawWidth) : width;
  const dockedWidth = dockedWidthOf(dockedMode, fullWidth);

  // 접히는 애니메이션이 끝날 때까지는 마지막 내용을 남겨 둔다(바로 내리면 빈 카드가 줄어든다)
  const lastVisibleRef = useRef<Exclude<SidebarMode, 'collapsed'>>(dockedMode === 'collapsed' ? 'rail' : dockedMode);
  if (dockedMode !== 'collapsed') lastVisibleRef.current = dockedMode;
  const contentMode = lastVisibleRef.current;
  const [mounted, setMounted] = useState(dockedMode !== 'collapsed');
  // 열고 닫히는 동안만 잘라낸다 — 늘 자르면 카드 그림자가 잘리고, 안 자르면 펼치는 동안 카드가 컬럼 위로 삐져나온다
  const [animating, setAnimating] = useState(false);
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (dockedMode !== 'collapsed') setMounted(true);
    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    if (!dragging) setAnimating(true);
  }, [dockedWidth]);

  // 끌어서 접은 경우: 끄는 동안 너비가 이미 0이 돼 애니메이션(끝 알림)이 없으므로 놓는 순간 내린다
  useEffect(() => {
    if (!dragging && dockedMode === 'collapsed' && !animating) setMounted(false);
  }, [dragging, dockedMode, animating]);

  // 좁은 화면에서 떠 있을 때 Esc → 레일
  const overlayOpen = isOverlay && mode === 'full';
  const { setMode } = sidebar;
  useEffect(() => {
    if (!overlayOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setMode('rail');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlayOpen, setMode]);

  return (
    <>
      {/* 바깥은 너비만 움직이고(0 ↔ 너비+틈), 안쪽 카드는 고정 너비 — 바뀌는 동안 내용이 찌그러지지 않는다 */}
      <m.div
        className="relative h-full shrink-0"
        initial={false}
        animate={{ width: dockedMode === 'collapsed' ? 0 : dockedWidth + GAP }}
        transition={dragging ? { duration: 0 } : SPRING}
        onAnimationComplete={() => {
          setAnimating(false);
          // 끄는 중엔 내리지 않는다 — 손잡이가 사라지면 포인터 캡처가 끊겨 '놓기'를 못 받는다
          if (dockedMode === 'collapsed' && !dragging) setMounted(false);
        }}
        style={{ overflow: animating || dockedMode === 'collapsed' ? 'hidden' : 'visible' }}
      >
        {mounted && (
          <aside className="relative h-full" style={{ width: dockedWidthOf(contentMode, fullWidth) }} aria-label="Sidebar">
            <div className={styles.card}>
              {contentMode === 'full'
                ? <FullContent {...tree} onCollapseToRail={toRail} />
                : <RailContent onExpand={toFull} onHide={hide} panels={tree.panels} onOpenSettings={tree.onOpenSettings} />}
            </div>
            {/* 좁은 화면의 레일은 끌지 않는다(전체는 위에 떠서 열리므로).
                끄는 중엔 미리보기가 '접힘'이어도 남겨 둔다 — 사라지면 포인터 캡처가 끊겨 '놓기'를 못 받는다 */}
            {(dockedMode !== 'collapsed' || edgeDrag.dragging) && !isOverlay && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
                aria-valuenow={dockedWidth}
                tabIndex={0}
                className={styles.handle}
                style={{ right: -GAP, width: GAP }}
                data-tt={dragging ? undefined : 'Drag to resize · double-click to reset'}
                onPointerDown={edgeDrag.start(dockedWidth)}
                {...edgeDrag.handlers}
                onDoubleClick={() => {
                  sidebar.commitWidth(FULL_DEFAULT);
                  setMode('full');
                }}
                onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                  e.preventDefault();
                  sidebar.commitDrag(dockedWidth + (e.key === 'ArrowRight' ? 24 : -24));
                }}
              >
                <span className={dragging ? styles.handleLineActive : styles.handleLineIdle} />
              </div>
            )}
          </aside>
        )}
      </m.div>

      {mode === 'collapsed' && !edgeDrag.dragging && <PullHandle drag={pullDrag} onRestore={sidebar.restore} />}

      {/* 좁은 화면: 전체는 컬럼 위에 뜬다 */}
      <AnimatePresence>
        {overlayOpen && (
          <>
            <m.div
              key="backdrop"
              className="absolute inset-0 z-[100] rounded-2xl bg-black/5"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={toRail}
            />
            <m.aside
              key="panel"
              className="absolute inset-y-0 left-0 z-[100] max-w-[calc(100%-2rem)]"
              style={{ width }}
              initial={{ opacity: 0, x: -24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={SPRING}
              aria-label="Sidebar"
            >
              <div className={styles.cardFloating}>
                <FullContent {...tree} onCollapseToRail={toRail} />
              </div>
            </m.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
