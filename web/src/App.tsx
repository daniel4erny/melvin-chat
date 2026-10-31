import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import LiveChat from "./pages/LiveChat";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/liveChat" element={<LiveChat />} />
    </Routes>
  );
}
