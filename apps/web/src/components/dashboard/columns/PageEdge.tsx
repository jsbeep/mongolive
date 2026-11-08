// 목록 맨 위·맨 아래의 페이지 화살표 행 + 끝에서 더 굴리면 넘기기.
//   - 화살표 행은 페이지 전환(PageTransition) 안에 둔다: 옛 페이지와 함께 접히고 새 페이지와 함께 펼쳐진다.
//   - 이전/다음 페이지가 있을 때만 그린다. 누르면 그 페이지로.
//   - 맨 끝에서 같은 방향으로 더 굴리면 화살표 행이 차오르고, 다 차면 넘어간다(당겨서 새로고침처럼).
//   - 다음 페이지는 맨 위에서, 이전 페이지는 맨 아래에서 시작한다 — 이어서 읽는 느낌이 나게.
// 오른쪽 페이지 레일(PageRail)은 그대로 둔다: 레일은 위치·바로가기, 이 행은 이어 넘기기.
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { animate, m, useMotionValue, useTransform, type MotionValue } from 'framer-motion';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../../utils/cn';

// 끝에서 이만큼(px) 더 굴리면 넘어간다
const PULL_PX = 220;
// 휠 이벤트가 이만큼 끊기면 새 동작으로 본다. 끝에 '닿은 채로 시작한' 동작만 당김으로 친다 —
// 스크롤해 내려오던 기세(트랙패드 관성 포함)로 곧장 넘어가지 않게
const GESTURE_GAP_MS = 180;
// 이만큼 굴리지 않으면 차오른 게 빠진다(휠을 한 칸씩 천천히 굴려도 쌓이도록 동작 간격보다 길게)
const RELEASE_MS = 450;
// 넘긴 직후엔 굴림을 무시한다 — 관성으로 여러 페이지가 한꺼번에 넘어가지 않게(이벤트가 계속 오면 늘어난다)
const COOLDOWN_MS = 500;
// 이전 페이지로 가면 맨 아래로 — 페이지 전환 애니메이션 동안 높이가 바뀌므로 이 시간 동안 따라 내린다
const LAND_MS = 500;

interface OverscrollPagingOptions {
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  // 순서 바꾸는 중·불러오는 중 등
  disabled?: boolean;
}

export interface OverscrollPaging {
  prevProgress: MotionValue<number>;
  nextProgress: MotionValue<number>;
  // 화살표 행을 눌러 넘길 때도 이걸로(도착 위치가 같아지게)
  goPrev: () => void;
  goNext: () => void;
  // 새 페이지가 그려진 뒤 부른다 — 도착 위치로 스크롤
  land: () => void;
}

export function useOverscrollPaging(scrollRef: RefObject<HTMLElement | null>, options: OverscrollPagingOptions): OverscrollPaging {
  const prevProgress = useMotionValue(0);
  const nextProgress = useMotionValue(0);
  const optsRef = useRef(options);
  optsRef.current = options;
  const landingRef = useRef<'top' | 'bottom'>('top');

  // 넘길 수 있을 때만 — 전환 중엔 사라지는 페이지의 화살표도 아직 눌리므로, 지금 기준으로 다시 확인한다
  const goPrev = useCallback(() => {
    if (!optsRef.current.canPrev) return;
    landingRef.current = 'bottom';
    optsRef.current.onPrev();
  }, []);
  const goNext = useCallback(() => {
    if (!optsRef.current.canNext) return;
    landingRef.current = 'top';
    optsRef.current.onNext();
  }, []);

  const land = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (landingRef.current === 'top') {
      el.scrollTo({ top: 0 });
      return;
    }
    landingRef.current = 'top';
    const started = performance.now();
    const follow = () => {
      el.scrollTop = el.scrollHeight;
      if (performance.now() - started < LAND_MS) requestAnimationFrame(follow);
    };
    follow();
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let lastWheel = 0;
    let lockedUntil = 0;
    let armedPrev = false;
    let armedNext = false;
    let pull = 0;
    let releaseTimer = 0;
    const atTop = () => el.scrollTop <= 1;
    const atBottom = () => el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    const show = () => {
      prevProgress.set(Math.min(1, Math.max(0, -pull) / PULL_PX));
      nextProgress.set(Math.min(1, Math.max(0, pull) / PULL_PX));
    };
    const release = () => {
      pull = 0;
      animate(prevProgress, 0, { duration: 0.18 });
      animate(nextProgress, 0, { duration: 0.18 });
    };

    const onWheel = (e: WheelEvent) => {
      const o = optsRef.current;
      if (o.disabled || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const now = performance.now();
      const newGesture = now - lastWheel > GESTURE_GAP_MS;
      lastWheel = now;
      if (now < lockedUntil) {
        // 넘긴 직후의 굴림(관성)은 새 페이지를 스크롤하지도 않게 막는다 — 새 페이지가 맨 위·맨 아래에서 시작하도록
        lockedUntil = Math.max(lockedUntil, now + GESTURE_GAP_MS);
        e.preventDefault();
        return;
      }
      if (newGesture) {
        armedPrev = atTop();
        armedNext = atBottom();
      }
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
      if (dy > 0 && armedNext && o.canNext && atBottom()) pull = Math.max(0, pull) + dy;
      else if (dy < 0 && armedPrev && o.canPrev && atTop()) pull = Math.min(0, pull) + dy;
      else return;
      window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(release, RELEASE_MS);
      if (Math.abs(pull) < PULL_PX) {
        show();
        return;
      }
      const forward = pull > 0;
      pull = 0;
      prevProgress.set(0);
      nextProgress.set(0);
      lockedUntil = now + COOLDOWN_MS;
      if (forward) goNext();
      else goPrev();
    };
    // 실제로 스크롤됐으면 이번 동작은 당김이 아니다
    const onScroll = () => {
      armedPrev = false;
      armedNext = false;
    };

    // passive: false — 위의 preventDefault 때문(평소엔 막지 않으므로 스크롤이 느려지지 않는다)
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', onScroll);
      window.clearTimeout(releaseTimer);
    };
  }, [scrollRef, prevProgress, nextProgress, goPrev, goNext]);

  return { prevProgress, nextProgress, goPrev, goNext, land };
}

interface PageEdgeProps {
  direction: 'prev' | 'next';
  progress: MotionValue<number>;
  onClick: () => void;
  busy?: boolean;
}

// 낮은 가운데 화살표(28px) — '페이지가 더 있다'는 걸 알릴 만큼만. 키보드 커서 대상(data-nav-row)은 아니다
export function PageEdge({ direction, progress, onClick, busy }: PageEdgeProps) {
  const Icon = direction === 'next' ? ChevronDown : ChevronUp;
  const y = useTransform(progress, (v) => (direction === 'next' ? 1 : -1) * v * 3);
  return (
    <button
      type="button"
      data-page-edge={direction}
      aria-label={direction === 'next' ? 'Next page' : 'Previous page'}
      data-tt={direction === 'next' ? 'Next page — or keep scrolling' : 'Previous page — or keep scrolling'}
      disabled={busy}
      onClick={onClick}
      className={cn(
        'group relative isolate flex shrink-0 items-center justify-center rounded-xl px-4 py-1 text-slate-300 transition-colors',
        'hover:bg-slate-50/80 hover:text-slate-500 active:bg-slate-100/60 disabled:opacity-50',
      )}
    >
      {/* 당긴 만큼 가운데서부터 차오르는 바탕 */}
      <m.span aria-hidden className="absolute inset-0 -z-10 rounded-xl bg-emerald-50" style={{ scaleX: progress, opacity: progress }} />
      <m.span className="flex h-5 items-center" style={{ y }}>
        <Icon size={16} />
      </m.span>
    </button>
  );
}
