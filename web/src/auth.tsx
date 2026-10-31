import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  api,
  getMeCache,
  getToken,
  setMeCache,
  setServer,
  setToken,
  setUnauthorizedHandler,
} from "./api";
import { applyTheme } from "./theme";
import { setErrorToasts } from "./toast";
import { socket } from "./ws";
import type { User } from "./types";

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string, server?: string) => Promise<void>;
  register: (input: {
    username: string;
    password: string;
    displayName: string;
    invite: string;
    server?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (patch: Record<string, unknown>) => Promise<User>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => getMeCache());
  const [loading, setLoading] = useState(true);

  const applyUser = (u: User | null) => {
    setUser(u);
    setMeCache(u);
    if (u) {
      applyTheme(u.settings);
      setErrorToasts(u.settings.showErrors);
    }
  };

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setMeCache(null);
      setUser(null);
      socket.close();
    });
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api<{ user: User }>("/api/auth/me")
      .then((res) => applyUser(res.user))
      .catch(() => {
        setToken(null);
        setMeCache(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = async (username: string, password: string, server?: string) => {
    if (server !== undefined) setServer(server);
    const res = await api<{ token: string; user: User }>("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    setToken(res.token);
    applyUser(res.user);
  };

  const register = async (input: {
    username: string;
    password: string;
    displayName: string;
    invite: string;
    server?: string;
  }) => {
    if (input.server !== undefined) setServer(input.server);
    const res = await api<{ token: string; user: User }>("/api/auth/register", {
      method: "POST",
      body: {
        username: input.username,
        password: input.password,
        displayName: input.displayName,
        invite: input.invite,
      },
    });
    setToken(res.token);
    applyUser(res.user);
  };

  const logout = async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: {} });
    } catch {
      // token might already be invalid
    }
    setToken(null);
    setMeCache(null);
    setUser(null);
    socket.close();
  };

  const updateUser = async (patch: Record<string, unknown>) => {
    const res = await api<{ user: User }>("/api/me", { method: "PATCH", body: patch });
    applyUser(res.user);
    return res.user;
  };

  const refresh = async () => {
    const res = await api<{ user: User }>("/api/auth/me");
    applyUser(res.user);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateUser, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
