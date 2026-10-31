import { useEffect } from "react";
import { useAuth } from "./auth";
import Login from "./pages/Login";
import Chat from "./pages/Chat";
import { Spinner } from "./components/ui";
import "./styles/app.css";

export default function App() {
  const { user, loading } = useAuth();

  useEffect(() => {
    document.documentElement.dataset.booted = "1";
  }, []);

  if (loading) {
    return (
      <div className="bootScreen">
        <div className="bootMark">M</div>
        <Spinner size={26} />
        <p>Startuji Melvin…</p>
      </div>
    );
  }

  return user ? <Chat /> : <Login />;
}
