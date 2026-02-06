import { html } from "./lib/preact.html.mjs";
import { useState, useEffect, useCallback, useRef } from "./lib/hooks.module.js";
import { NodeList } from "./component/nodeList.mjs";
import { Header } from "./component/header.mjs";
import { RefreshButton } from "./component/refreshButton.mjs";
import { AddInstanceButton } from "./component/addInstanceButton.mjs";
import { TaskList } from "./component/taskList.mjs";
import { LoginForm } from "./component/loginForm.mjs";

const API_PREFIX = window.location.pathname.startsWith("/admin") ? "/admin" : "";
const DEFAULT_AUTH_MODE = "tapis-jwt";

const getTokenFromHash = () => {
  const raw = (window.location.hash || "").replace(/^#/, "");
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const token = params.get("token");
  return token && token.trim().length > 0 ? token.trim() : null;
};

const clearTokenFromHash = () => {
  if (window.location.hash) {
    window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
  }
};

const LoadingScreen = () =>
  html`<div class="loading-screen">
    <div class="spinner-border text-primary" role="status">
      <span class="visually-hidden">Loading…</span>
    </div>
  </div>`;

export default function App() {
  const [auth, setAuth] = useState({
    status: "loading",
    user: null,
    error: null,
    legacy: false,
  });
  const [authConfig, setAuthConfig] = useState({ mode: "loading" });
  const [info, setInfo] = useState({ name: "", version: "" });
  const [nodes, setNodes] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const refreshIntervalRef = useRef(null);

  const loadAuthConfig = useCallback(async () => {
    try {
      const response = await fetch(`${API_PREFIX}/auth/config`, {
        credentials: "include",
        cache: "no-cache",
      });

      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }

      const data = await response.json();
      setAuthConfig(data);
      return data;
    } catch (err) {
      console.warn("Failed to load auth config:", err);
      setAuthConfig((prev) => (prev && prev.mode ? prev : { mode: "unknown" }));
      return null;
    }
  }, []);

  const checkSession = useCallback(async () => {
    try {
      const response = await fetch(`${API_PREFIX}/auth/session`, {
        credentials: "include",
        cache: "no-cache",
      });

      if (!response.ok) {
        throw new Error("Not authenticated");
      }

      const data = await response.json();
      setAuth({
        status: "authenticated",
        user: data.user || null,
        error: null,
        legacy: !!data.legacy,
      });
      if (data.mode) {
        setAuthConfig((prev) => Object.assign({}, prev, { mode: data.mode }));
      }
      return true;
    } catch (err) {
      setAuth({ status: "unauthenticated", user: null, error: null, legacy: false });
      loadAuthConfig().catch(() => {});
      return false;
    }
  }, [loadAuthConfig]);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  useEffect(() => {
    loadAuthConfig().catch(() => {});
  }, [loadAuthConfig]);

  useEffect(() => {
    if (auth.status !== "unauthenticated") return;
    if (authConfig.mode !== "tapis-jwt") return;
    const token = getTokenFromHash();
    if (!token) return;
    handleLogin({ token })
      .catch((err) => console.warn("Auto-login failed:", err))
      .finally(clearTokenFromHash);
  }, [auth.status, authConfig.mode, handleLogin]);

  const getJson = useCallback(
    async (path) => {
      const response = await fetch(`${API_PREFIX}${path}`, {
        credentials: "include",
        cache: "no-cache",
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch (_) {
        payload = null;
      }

      if (response.status === 401) {
        setAuth({ status: "unauthenticated", user: null, error: null, legacy: false });
        throw new Error("Unauthorized");
      }

      if (!response.ok) {
        const message = payload && payload.error ? payload.error : `Request failed (${response.status})`;
        throw new Error(message);
      }

      return payload;
    },
    []
  );

  const loadInfo = useCallback(async () => {
    try {
      const infoData = await getJson("/r/info");
      setInfo(infoData || { name: "", version: "" });
    } catch (err) {
      console.error("Failed to fetch info:", err);
      setInfo({ name: "", version: "" });
    }
  }, [getJson]);

  const loadNodes = useCallback(async () => {
    try {
      const nodesData = await getJson("/r/node/list");
      setNodes(Array.isArray(nodesData) ? nodesData : []);
    } catch (err) {
      console.error("Failed to fetch nodes:", err);
      setNodes([]);
    }
  }, [getJson]);

  const loadTasks = useCallback(async () => {
    try {
      const tasksData = await getJson("/r/task/list?details=true");
      setTasks(Array.isArray(tasksData) ? tasksData : []);
    } catch (err) {
      console.error("Failed to fetch tasks:", err);
      setTasks([]);
    }
  }, [getJson]);

  const loadAll = useCallback(async () => {
    await Promise.all([loadInfo(), loadNodes(), loadTasks()]);
  }, [loadInfo, loadNodes, loadTasks]);

  useEffect(() => {
    if (auth.status === "authenticated") {
      loadAll().catch((err) => console.error("Failed to refresh dashboard data:", err));
    } else {
      setInfo({ name: "", version: "" });
      setNodes([]);
      setTasks([]);
      setAutoRefreshEnabled(false);
    }
  }, [auth.status, loadAll]);

  useEffect(() => {
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
      refreshIntervalRef.current = null;
    }

    if (auth.status === "authenticated" && autoRefreshEnabled) {
      refreshIntervalRef.current = setInterval(() => {
        loadNodes().catch((err) => console.error("Failed to refresh nodes:", err));
        loadTasks().catch((err) => console.error("Failed to refresh tasks:", err));
      }, 5000);
    }

    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
    };
  }, [auth.status, autoRefreshEnabled, loadNodes, loadTasks]);

  const handleLogin = useCallback(
    async (credentials = {}) => {
      const mode =
        authConfig.mode && authConfig.mode !== "loading" && authConfig.mode !== "unknown"
          ? authConfig.mode
          : DEFAULT_AUTH_MODE;

      const payload = {};
      if (mode === "tapis-jwt") {
        const token = (credentials.token || "").trim();
        if (!token) {
          const message = "A Tapis JWT token is required.";
          setAuth({ status: "unauthenticated", user: null, error: message, legacy: false });
          throw new Error(message);
        }
        payload.token = token;
      } else {
        const username = (credentials.username || "").trim();
        const password = credentials.password || "";
        if (!username || !password) {
          const message = "Username and password are required.";
          setAuth({ status: "unauthenticated", user: null, error: message, legacy: false });
          throw new Error(message);
        }
        payload.username = username;
        payload.password = password;
      }

      setAuth((prev) => ({ ...prev, error: null }));

      const response = await fetch(`${API_PREFIX}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      let data = {};
      try {
        data = await response.json();
      } catch (_) {
        data = {};
      }

      if (!response.ok) {
        const message = data && data.error ? data.error : "Login failed";
        setAuth({ status: "unauthenticated", user: null, error: message, legacy: false });
        throw new Error(message);
      }

      setAuth({
        status: "authenticated",
        user: data.user || null,
        error: null,
        legacy: !!data.legacy,
      });
      if (data.mode) {
        setAuthConfig((prev) => Object.assign({}, prev, { mode: data.mode }));
      }
      await loadAll().catch((err) => console.error("Failed to refresh data after login:", err));
      await loadAuthConfig().catch(() => {});
    },
    [authConfig.mode, loadAll, loadAuthConfig]
  );

  const handleLogout = useCallback(async () => {
    try {
      await fetch(`${API_PREFIX}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch (err) {
      console.warn("Failed to logout:", err);
    } finally {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
      setAutoRefreshEnabled(false);
      setAuth({ status: "unauthenticated", user: null, error: null, legacy: false });
      loadAuthConfig().catch(() => {});
    }
  }, [loadAuthConfig]);

  if (auth.status === "loading") {
    return html`<${LoadingScreen} />`;
  }

  if (auth.status !== "authenticated") {
    return html`
      <${LoginForm}
        onSubmit=${handleLogin}
        error=${auth.error}
        mode=${authConfig.mode}
        authConfig=${authConfig}
      />
    `;
  }

  return html`
    <div class="container">
      <${Header} info=${info} user=${auth.user} onSignOut=${handleLogout} />
      <${NodeList} nodes=${nodes} getData=${loadNodes} refreshTasks=${loadTasks} />
      <${TaskList} tasks=${tasks} refreshTasks=${loadTasks} />

      <div id="btn-area">
        <${AddInstanceButton} getNodes=${loadNodes} />
        <div style="flex-grow: 1"></div>
        <${RefreshButton}
          enabled=${autoRefreshEnabled}
          onChange=${setAutoRefreshEnabled}
          disabled=${auth.status !== "authenticated"}
        />
      </div>
    </div>
  `;
}
