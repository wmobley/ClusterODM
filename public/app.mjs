import { html, render } from "./lib/preact.html.mjs";
import { useState, useEffect, useCallback } from "./lib/hooks.module.js";
import { NodeList } from "./component/nodeList.mjs";
import { Header } from "./component/header.mjs";
import { RefreshButton } from "./component/refreshButton.mjs";
import { AddInstanceButton } from "./component/addInstanceButton.mjs";
import { TaskList } from "./component/taskList.mjs";

const API_PREFIX = window.location.pathname.startsWith("/admin") ? "/admin" : "";

const getInfoData = async () => {
  console.log("try getInfoData");
  const res = await fetch(`${API_PREFIX}/r/info`);
  const json = await res.json();
  return json;
};
const getNodesData = async () => {
  console.log("try getNodesData");
  const res = await fetch(`${API_PREFIX}/r/node/list`);
  const json = await res.json();
  return json;
};
const getTasksData = async () => {
  console.log("try getTasksData");
  const res = await fetch(`${API_PREFIX}/r/task/list?details=true`);
  const json = await res.json();
  return json;
};
const useNodes = () => {
  const [nodes, setNodes] = useState([]);
  const getData = () => {
    console.log("try get nodes");
    getNodesData()
      .then((nodes) => {
        if (Array.isArray(nodes)) {
          setNodes(nodes);
        } else {
          console.warn("Received non-array nodes payload:", nodes);
          setNodes([]);
        }
      })
      .catch((err) => {
        console.error("Failed to fetch nodes:", err);
        setNodes([]);
      });
  };

  return [nodes, getData];
};
const useTasks = () => {
  const [tasks, setTasks] = useState([]);
  const getData = () => {
    console.log("try get tasks");
    getTasksData()
      .then((list) => {
        if (Array.isArray(list)) {
          setTasks(list);
        } else {
          console.warn("Received non-array tasks payload:", list);
          setTasks([]);
        }
      })
      .catch((err) => {
        console.error("Failed to fetch tasks:", err);
        setTasks([]);
      });
  };

  return [tasks, getData];
};

export default function App() {
  const [info, setInfo] = useState({ name: "", version: "" });
  const [nodes, getNodes] = useNodes();
  const [tasks, getTasks] = useTasks();

  const [autoRefresh, setAutoRefresh] = useState({ isAutoRefresh: false, intervalHandler: null });

  useEffect(() => {
    getInfoData().then((infoData) => setInfo(infoData));
    getNodes();
    getTasks();
  }, []);

  useEffect(() => {
    if (autoRefresh.isAutoRefresh) {
      const intervalHandler = setInterval(() => {
        getNodes();
        getTasks();
      }, 5000);
      setAutoRefresh({ ...autoRefresh, intervalHandler });
    } else {
      if (autoRefresh.intervalHandler > 0) {
        clearInterval(autoRefresh.intervalHandler);
        setAutoRefresh({ ...autoRefresh, intervalHandler: null });
      }
    }
  }, [autoRefresh.isAutoRefresh]);

  return html` <div class="container">
    <${Header} info=${info} />
    <${NodeList} nodes=${nodes} getData=${getNodes} refreshTasks=${getTasks} />
    <${TaskList} tasks=${tasks} />

    <div id="btn-area">
      <${AddInstanceButton} getNodes=${getNodes} />
      <div style="flex-grow:1"></div>
      <${RefreshButton} autoRefresh=${autoRefresh} setAutoRefresh=${setAutoRefresh} />
    </div>
  </div>`;
}
