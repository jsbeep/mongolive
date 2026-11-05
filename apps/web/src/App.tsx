import { LazyMotion, domMax } from "framer-motion";
import { AuthGate } from "./components/auth/AuthGate";
import ExplorerPage from "./pages/page";

export default function App() {
  return (
    <LazyMotion features={domMax}>
      {/* 로그인 전엔 앱을 아예 띄우지 않는다 — 데이터 요청도, 실시간 연결도 로그인 뒤에 시작 */}
      <AuthGate>
        <ExplorerPage />
      </AuthGate>
    </LazyMotion>
  );
}