import { LazyMotion, domMax } from "framer-motion";
import ExplorerPage from "./pages/page";

export default function App() {
  return (
    <LazyMotion features={domMax}>
      <ExplorerPage />
    </LazyMotion>
  );
}