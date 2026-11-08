import { useEffect } from "react";
import { LazyMotion, MotionConfig, domMax } from "framer-motion";
import { AuthGate } from "./components/auth/AuthGate";
import ExplorerPage from "./pages/page";
import { monoFontStack, usePreferences } from "./services/preferences";

// 설정 › Display › Animations — 앱 전체 애니메이션(사이드바·모달·알림·컬럼)을 한 번에.
//   auto → 'user': OS의 '동작 줄이기'를 따른다 / on → 'never': 늘 움직임 / off → 'always': 움직임 없이(투명도만)
const REDUCED_MOTION = { auto: "user", on: "never", off: "always" } as const;

export default function App() {
  const { animations, monoFont } = usePreferences();
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
