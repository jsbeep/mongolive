import { useEffect } from "react";
import { LazyMotion, MotionConfig, domMax } from "framer-motion";
import { AuthGate } from "./components/auth/AuthGate";
import ExplorerPage from "./pages/page";
import { monoFontStack, usePreferences } from "./services/preferences";

// 설정 › Display › Animations — 앱 전체 애니메이션(사이드바·모달·알림·컬럼)을 한 번에.
//   auto → 'user': OS의 '동작 줄이기'를 따른다 / on → 'never': 늘 움직임 / off → 'always': 움직임 없이(투명도만)
const REDUCED_MOTION = { auto: "user", on: "never", off: "always" } as const;

export default function App() {
  const { animations, monoFont, theme } = usePreferences();
  // 설정 › Display › Theme — <html class="dark">면 색 변수가 다크 값으로 바뀐다(tailwind.config.cjs).
  // system이면 OS 설정을 따르고, OS에서 바꾸면 바로 따라간다. 첫 화면은 index.html의 스크립트가 먼저 맞춰 둔다(깜빡임 방지)
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && query.matches));
    apply();
    if (theme !== "system") return;
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [theme]);
  // 설정 › Display › Monospace font — 앱 전체의 font-mono가 이 변수를 따른다(tailwind.config, index.css)
  useEffect(() => {
    document.documentElement.style.setProperty("--font-mono", monoFontStack(monoFont));
  }, [monoFont]);
  return (
    <LazyMotion features={domMax}>
      <MotionConfig reducedMotion={REDUCED_MOTION[animations]}>
        {/* 로그인 전엔 앱을 아예 띄우지 않는다 — 데이터 요청도, 실시간 연결도 로그인 뒤에 시작 */}
        <AuthGate>
          <ExplorerPage />
        </AuthGate>
      </MotionConfig>
    </LazyMotion>
  );
}
