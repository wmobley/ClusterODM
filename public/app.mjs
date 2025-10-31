import { html } from "./lib/preact.html.mjs";
import { useState, useEffect, useCallback, useRef } from "./lib/hooks.module.js";
import { NodeList } from "./component/nodeList.mjs";
import { Header } from "./component/header.mjs";
import { RefreshButton } from "./component/refreshButton.mjs";
import { AddInstanceButton } from "./component/addInstanceButton.mjs";
import { TaskList } from "./component/taskList.mjs";
import { LoginForm } from "./component/loginForm.mjs";

const API_PREFIX = window.location.pathname.startsWith("/admin") ? "/admin" : "";

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
  const [info, setInfo] = useState({ name: "", version: "" });
  const [nodes, setNodes] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const refreshIntervalRef = useRef(null);

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
      return true;
    } catch (err) {
      setAuth({ status: "unauthenticated", user: null, error: null, legacy: false });
      return false;
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

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
    async ({ username, password }) => {
      const response = await fetch(`${API_PREFIX}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password }),
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
        user: data.user || { username },
        error: null,
        legacy: false,
      });
      await loadAll().catch((err) => console.error("Failed to refresh data after login:", err));
    },
    [loadAll]
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
    }
  }, []);

  if (auth.status === "loading") {
    return html`<${LoadingScreen} />`;
  }

  if (auth.status !== "authenticated") {
    return html`<${LoginForm} onSubmit=${handleLogin} error=${auth.error} />`;
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
