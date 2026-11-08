// 밀러 컬럼 키보드 탐색 — Finder의 컬럼 보기처럼 키보드만으로 다닌다.
//   ↑ ↓ / k j      같은 컬럼 안에서 행 이동
//   → / l / Enter  고른 행 펼치기 → 다음 컬럼 첫 행으로(펼칠 게 없는 필드에서 Enter = 편집)
//   ← / h          앞 컬럼으로(그 컬럼에서 펼쳐 둔 행에)
//   e / F2         편집          Delete  삭제(확인 창은 설정대로)
//   /              그 컬럼의 필터 입력칸     ?  단축키 목록     Esc  커서 숨기기
// 입력칸 안이거나 모달이 떠 있으면 아무것도 하지 않는다. 마우스로 행을 누르면 커서가 거기로 옮겨 간다.
// 컬럼·행은 utils/keyboardNav의 표시(data-nav-col / data-nav-row)로 찾는다 — 각 컬럼은 키를 모른다.
// 커서는 DOM 속성(data-kb-cursor)으로 그린다: 실시간 반영 등으로 행이 다시 그려지면 MutationObserver가 다시 붙인다.
import { useEffect, useRef, type RefObject } from 'react';
import { navActionsOf } from '../utils/keyboardNav';

interface Cursor {
  col: number;
  row: number;
}

const CURSOR_ATTR = 'data-kb-cursor';
// 펼친 뒤 다음 컬럼이 그려지기를 기다리는 최대 시간
const OPEN_WAIT_MS = 1500;

const isTyping = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');

export function useMillerKeyboard(containerRef: RefObject<HTMLElement | null>, onShowShortcuts: () => void) {
  const cursorRef = useRef<Cursor | null>(null);
  // 키를 한 번이라도 눌러야 커서가 보인다(마우스만 쓰는 사람에겐 안 보이게)
  const visibleRef = useRef(false);
  const showShortcutsRef = useRef(onShowShortcuts);
  showShortcutsRef.current = onShowShortcuts;

  useEffect(() => {
    const root = () => containerRef.current;

    // 지금 화면의 컬럼 번호들(경로 순서)
    const columns = (): number[] => {
      const el = root();
      if (!el) return [];
      const set = new Set<number>();
      el.querySelectorAll<HTMLElement>('[data-nav-col]').forEach((c) => set.add(Number(c.dataset.navCol)));
      return [...set].sort((a, b) => a - b);
    };
    const columnEl = (col: number) => root()?.querySelector<HTMLElement>(`[data-nav-col="${col}"]`) ?? null;
    // 그 컬럼'에 속한' 행만(Tree 모드에선 안에 다음 컬럼이 들어 있으므로 가장 가까운 컬럼이 자기인 것만)
    const rowsOf = (col: number): HTMLElement[] => {
      const c = columnEl(col);
      if (!c) return [];
      return [...c.querySelectorAll<HTMLElement>('[data-nav-row]')].filter((r) => r.closest('[data-nav-col]') === c);
    };
    const activeRowIndex = (col: number) => Math.max(0, rowsOf(col).findIndex((r) => r.hasAttribute('data-nav-active')));

    const clearMark = () => root()?.querySelectorAll(`[${CURSOR_ATTR}]`).forEach((r) => r.removeAttribute(CURSOR_ATTR));
    const currentRow = (): HTMLElement | null => {
      const c = cursorRef.current;
      return c ? rowsOf(c.col)[c.row] ?? null : null;
    };

    // 커서를 그린다 — 컬럼이 사라졌으면 가장 가까운 컬럼으로, 행 번호는 범위 안으로
    const paint = (scroll: boolean) => {
      clearMark();
      const c = cursorRef.current;
      if (!c || !visibleRef.current) return;
      const cols = columns();
      if (!cols.length) return;
      if (!cols.includes(c.col)) c.col = cols.reduce((best, x) => (Math.abs(x - c.col) < Math.abs(best - c.col) ? x : best), cols[0]);
      const rows = rowsOf(c.col);
      if (!rows.length) return;
      c.row = Math.min(Math.max(0, c.row), rows.length - 1);
      rows[c.row].setAttribute(CURSOR_ATTR, '');
      if (scroll) rows[c.row].scrollIntoView({ block: 'nearest' });
    };

    // 처음: 가장 깊은 컬럼의 펼친 행(없으면 첫 행)
    const ensureCursor = () => {
      if (cursorRef.current) return;
      const cols = columns();
      if (!cols.length) return;
      const col = cols[cols.length - 1];
      cursorRef.current = { col, row: activeRowIndex(col) };
    };

    // 펼친 뒤 다음 컬럼이 생기면 그 첫 행으로
    const moveIntoNext = (fromCol: number) => {
      const started = Date.now();
      const tick = () => {
        const next = columns().find((x) => x > fromCol);
        if (next !== undefined && rowsOf(next).length) {
          cursorRef.current = { col: next, row: 0 };
          paint(true);
        } else if (Date.now() - started < OPEN_WAIT_MS) {
          setTimeout(tick, 60);
        }
      };
      setTimeout(tick, 60);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const key = e.key;
      const handled = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Delete', 'F2', 'Escape', 'j', 'k', 'h', 'l', 'e', '/', '?'];
      if (!handled.includes(key)) return;
      if (!root()) return;

      if (key === '?') {
        e.preventDefault();
        showShortcutsRef.current();
        return;
      }
      if (key === 'Escape') {
        if (!visibleRef.current) return;
        visibleRef.current = false;
        clearMark();
        return;
      }

      // 버튼에 포커스가 있을 때 Enter는 그 버튼의 일 — 커서가 안 보이는 동안엔 가로채지 않는다
      if (key === 'Enter' && !visibleRef.current) return;

      ensureCursor();
      const c = cursorRef.current;
      if (!c) return;
      e.preventDefault();
      // 처음 누른 키는 커서를 보여 주기만(어디 있는지 보고 나서 움직이게)
      if (!visibleRef.current) {
        visibleRef.current = true;
        paint(true);
        return;
      }

      const cols = columns();
      const row = currentRow();
      const actions = row ? navActionsOf(row) : {};
      switch (key) {
        case 'ArrowDown':
        case 'j':
          c.row += 1;
          break;
        case 'ArrowUp':
        case 'k':
          c.row -= 1;
          break;
        case 'ArrowLeft':
        case 'h': {
          const prev = [...cols].reverse().find((x) => x < c.col);
          if (prev !== undefined) cursorRef.current = { col: prev, row: activeRowIndex(prev) };
          break;
        }
        case 'ArrowRight':
        case 'l':
        case 'Enter':
          if (actions.open) {
            actions.open();
            moveIntoNext(c.col);
          } else if (key === 'Enter') {
            actions.edit?.();
          }
          break;
        case 'e':
        case 'F2':
          actions.edit?.();
          break;
        case 'Delete':
          actions.remove?.();
          break;
        case '/': {
          // 그 컬럼의 필터 버튼을 눌러 입력칸을 열고 거기로
          const colEl = columnEl(c.col);
          const input = () => colEl?.querySelector<HTMLInputElement>('input[type="text"], input:not([type])');
          if (!input()) colEl?.querySelector<HTMLButtonElement>('button[data-tt^="Filter"]')?.click();
          setTimeout(() => input()?.focus(), 60);
          break;
        }
      }
      paint(true);
    };

    // 마우스로 행을 누르면 커서도 거기로(보이고 있을 때 키보드로 이어 가게)
    const onPointerDown = (e: PointerEvent) => {
      const row = (e.target as Element | null)?.closest<HTMLElement>('[data-nav-row]');
      const colEl = row?.closest<HTMLElement>('[data-nav-col]');
      if (!row || !colEl || !root()?.contains(row)) return;
      const col = Number(colEl.dataset.navCol);
      cursorRef.current = { col, row: Math.max(0, rowsOf(col).indexOf(row)) };
      paint(false);
    };

    // 행이 다시 그려지면(실시간 반영·페이지 이동) 커서 표시가 사라지므로 다시 붙인다
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (!visibleRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const row = currentRow();
        if (!row || !row.hasAttribute(CURSOR_ATTR)) paint(false);
      });
    });
    const el = root();
    if (el) observer.observe(el, { childList: true, subtree: true });

    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [containerRef]);
}
