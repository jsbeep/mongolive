// 사이드바 버튼으로 여는 떠 있는 패널의 겉모양 — 누른 버튼 오른쪽에 뜬다(전체·아이콘 레일 어느 쪽에서든).
// 바깥을 누르거나 Esc면 닫힌다. 사이드바의 패널 버튼(data-sidebar-panel-toggle)을 누르는 건 그 버튼이 처리한다
// (같은 버튼 = 닫기, 다른 버튼 = 그 패널로 바꾸기). 쓰는 곳: Query(쿼리 기록), References(선언한 참조 전체).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface SidebarPopoverProps {
  // 붙일 자리(누른 버튼의 화면 위치)
  anchor: DOMRect;
  title: string;
  icon: ReactNode;
  // 제목 줄 오른쪽(닫기 앞)에 둘 버튼들
  actions?: ReactNode;
  width?: number;
  onClose: () => void;
  children: ReactNode;
}

const MARGIN = 12;

export function SidebarPopover({ anchor, title, icon, actions, width = 340, onClose, children }: SidebarPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.top);

  // 화면 아래로 넘치면 위로 올린다(내용 높이가 바뀌어도)
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const place = () => setTop(Math.max(MARGIN, Math.min(anchor.top, window.innerHeight - el.offsetHeight - MARGIN)));
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [anchor.top]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (panelRef.current?.contains(target) || target?.closest('[data-sidebar-panel-toggle]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const left = Math.min(anchor.right + 8, window.innerWidth - width - MARGIN);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={title}
      className="fixed z-[120] flex max-h-[70vh] flex-col overflow-hidden rounded-2xl bg-white shadow-elevated ring-1 ring-slate-200/70"
      style={{ left, top, width }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-3.5 py-2.5">
        <span className="text-slate-400">{icon}</span>
        <span className="flex-1 truncate text-[13px] font-semibold text-slate-700">{title}</span>
        {actions}
        <button type="button" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{children}</div>
    </div>,
    document.body,
  );
}
