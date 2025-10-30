import { deleteFetch, postFetch } from "../common.fetch.js";
import { useEffect, useState } from "../lib/hooks.module.js";
import { html } from "../lib/preact.html.mjs";
import { DeleteInstanceDialog } from "./dialog.mjs";
export const NodeList = ({ nodes = [], getData = () => {} }) => {
  const LockBtn = ({ isLock, number }) =>
    isLock
      ? html`<button class="btn btn-sm btn-outline-secondary mx-1" onClick=${(e) => doUnLock(number)}>
          <i class="bi bi-lock"></i>
          UNLOCK
        </button>`
      : html`<button class="btn btn-sm btn-outline-primary mx-1" onClick=${(e) => doLock(number)}>
          <i class="bi bi-lock-fill"></i>
          LOCK
        </button>`;
  const DelBtn = ({ number }) => {
    // onClick=${(e) => doDelete(number)}
    const [open, setOpen] = useState(false);
    const handlerOnClickBtn = (e) => {
      setOpen(!open);
    };
    const handlerClose = () => {
      setOpen(false);
    };
    return html`<div>
      <button class="btn btn-sm  btn-outline-danger" onClick=${handlerOnClickBtn}>
        <i class="bi bi-trash-fill"></i>
        DEL
      </button>
      <${DeleteInstanceDialog}
        open=${open}
        handlerClose=${handlerClose}
        handlerApply=${() => {
          doDelete(number);
        }}
      />
    </div>`;
  };

  const doLock = (number) => {
    postFetch("/r/node/lock", {
      body: { number },
    })
      .then((res) => res.json())
      .then((isSuccess) => {
        getData();
      })
      .catch((ex) => {
        console.error(ex);
      });
  };

  const doUnLock = (number) => {
    postFetch("/r/node/unlock", {
      body: { number },
    })
      .then((res) => res.json())
      .then((isSuccess) => {
        getData();
      })
      .catch((ex) => {
        console.error(ex);
      });
  };

  const doDelete = (number) => {
    deleteFetch("/r/node", {
      body: { number },
    })
      .then((res) => res.json())
      .then((isSuccess) => {
        getData();
      })
      .catch((ex) => {
        console.error(ex);
      });
  };
  return html` <table class="table table-hover table-striped">
    <thead>
      <tr class="text-white bg-primary">
        <th>#</th>
        <th>Node</th>
        <th>Status</th>
        <th>Queue</th>
        <th>Engine</th>
        <th>API</th>
        <th>CPU Cores</th>
        <th>RAM available</th>
        <!--<th>Last updated</th>-->
        <th>Flags</th>
        <th>Link</th>
        <th>-</th>
      </tr>
    </thead>
    <tbody>
      ${nodes &&
      nodes.map((node, idx) => {
        const flags = [];
        if (node.isLocked) flags.push("L");
        if (node.isAutoSpawned) flags.push("A");
        return html`<tr>
          <td>${idx + 1}</td>
          <td>${node.name}</td>
          <td>
            <${IsOnline} isOnline=${node.isOnline} />
          </td>
          <td>${node.getTaskQueueCount}/${node.getMaxParallelTasks}</td>
          <td>${node.getEngineInfo}</td>
          <td>${node.getVersion}</td>
          <td>${node.nodeData.info.cpuCores}</td>
          <td>${getRamAvailable(node)}</td>
          <!--<td>${node.nodeData.lastRefreshed > 0 && new Date(node.nodeData.lastRefreshed).toLocaleString()}</td>-->
          <td>${flags.join(",")}</td>
          <td>${renderNodeLink(node)}</td>
          <td>
            <div class="btn-group" role="group">
              <${LockBtn} isLock=${node.isLocked} number=${idx + 1} />
              <${DelBtn} number=${idx + 1} />
            </div>
          </td>
        </tr>`;
      })}
    </tbody>
  </table>`;
};

const IsOnline = ({ isOnline = false }) =>
  isOnline ? html`<span class="badge bg-success">Online</span>` : html`<span class="badge bg-danger">Offline</span>`;

const getRamAvailable = (node) => {
  const { availableMemory, totalMemory } = node?.nodeData?.info;

  if (typeof availableMemory !== "number" || typeof totalMemory !== "number") return "";

  const percent = (availableMemory / totalMemory) * 100;
  const ram = `${bytesToSize(availableMemory)}/${bytesToSize(totalMemory)}`;
  const strPercent = `${percent.toFixed(2)}%`;
  return html`<span data-bs-toggle="tooltip" title=${ram}>${strPercent}</span>`;
};

const bytesToSize = (bytes, decimals = 2) => {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
};

const renderNodeLink = (node) => {
  const hostname = node?.nodeData?.hostname;
  const port = node?.nodeData?.port;
  if (!hostname || !port) return html`<span class="text-muted">N/A</span>`;

  const token = node?.nodeData?.token;
  const numericPort = Number(port);
  const proto = numericPort === 443 ? "https" : "http";
  const defaultPort = proto === "https" ? 443 : 80;
  const portSegment = numericPort && numericPort !== defaultPort ? `:${numericPort}` : "";
  const baseUrl = `${proto}://${hostname}${portSegment}`;
  const fullUrl = token ? `${baseUrl}/?token=${encodeURIComponent(token)}` : baseUrl;

  const clusterBaseUrl = window.location.origin;
  const buildClusterUrl = (path, params = {}) => {
    const query = new URLSearchParams(params);
    const queryString = query.toString();
    return queryString ? `${clusterBaseUrl}${path}?${queryString}` : `${clusterBaseUrl}${path}`;
  };

  const defaultParams = token ? { token } : {};
  const infoUrl = buildClusterUrl("/info", defaultParams);
  const taskListUrl = buildClusterUrl("/task/list", defaultParams);

  const handleChange = (event) => {
    const { value, selectedIndex } = event.target;
    const resetSelection = () => {
      event.target.selectedIndex = 0;
    };

    if (!value) return;

    if (value === "node-open") {
      window.open(fullUrl, "_blank", "noopener,noreferrer");
      resetSelection();
      return;
    }

    if (value === "cluster-info") {
      window.open(infoUrl, "_blank", "noopener,noreferrer");
      resetSelection();
      return;
    }

    if (value === "cluster-task-list") {
      window.open(taskListUrl, "_blank", "noopener,noreferrer");
      resetSelection();
      return;
    }

    if (value === "cluster-task-info" || value === "cluster-task-output") {
      const uuid = window.prompt("Enter task UUID");
      if (uuid) {
        const trimmed = uuid.trim();
        if (trimmed) {
          const path = `/task/${encodeURIComponent(trimmed)}/${value === "cluster-task-info" ? "info" : "output"}`;
          const params = { ...defaultParams };
          if (value === "cluster-task-output") {
            params.line = 0;
          }
          const url = buildClusterUrl(path, params);
          window.open(url, "_blank", "noopener,noreferrer");
        }
      }
      resetSelection();
      return;
    }

    // Unknown option, reset to placeholder
    if (selectedIndex !== 0) {
      resetSelection();
    }
  };

  return html`
    <select class="form-select form-select-sm link-dropdown" onChange=${handleChange}>
      <option value="">Open…</option>
      <option value="node-open">Node UI</option>
      <option value="cluster-info">Cluster info</option>
      <option value="cluster-task-list">Cluster task list</option>
      <option value="cluster-task-info">Cluster task info…</option>
      <option value="cluster-task-output">Cluster task output…</option>
    </select>
  `;
};
