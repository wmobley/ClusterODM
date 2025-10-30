import { html } from "../lib/preact.html.mjs";

const clusterBaseUrl = window.location.origin;

const buildClusterUrl = (path, token, extraParams = {}) => {
  const params = new URLSearchParams();
  if (token) {
    params.set("token", token);
  }
  Object.entries(extraParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, value);
    }
  });

  const query = params.toString();
  return query ? `${clusterBaseUrl}${path}?${query}` : `${clusterBaseUrl}${path}`;
};

const buildNodeUrl = (node, token) => {
  if (!node || !node.hostname || !node.port) return null;

  const numericPort = Number(node.port);
  const proto = numericPort === 443 ? "https" : "http";
  const defaultPort = proto === "https" ? 443 : 80;
  const portSegment = numericPort && numericPort !== defaultPort ? `:${numericPort}` : "";

  const baseUrl = `${proto}://${node.hostname}${portSegment}`;
  if (token) {
    return `${baseUrl}/?token=${encodeURIComponent(token)}`;
  }

  return baseUrl;
};

const formatToken = (token) => {
  if (!token) return html`<span class="text-muted">-</span>`;
  if (token.length <= 12) return token;
  return html`<span title=${token}>${token.slice(0, 6)}…${token.slice(-4)}</span>`;
};

const formatStatus = (task) => {
  const info = task?.taskInfo;
  if (!info) {
    return task.source === "pending"
      ? html`<span class="badge bg-secondary">Pending</span>`
      : html`<span class="badge bg-light text-dark">Unknown</span>`;
  }

  const status = info.status;
  if (!status) return html`<span class="badge bg-light text-dark">Unknown</span>`;

  const code = typeof status === "object" && status.code ? status.code : status;

  const badgeClass = (() => {
    switch (code) {
      case "COMPLETED":
        return "badge bg-success";
      case "RUNNING":
      case "QUEUED":
        return "badge bg-info text-dark";
      case "FAILED":
      case "CANCELED":
        return "badge bg-danger";
      default:
        return "badge bg-light text-dark";
    }
  })();

  return html`<span class=${badgeClass}>${code}</span>`;
};

const formatTimestamp = (timestamp) => {
  if (!timestamp) return html`<span class="text-muted">-</span>`;
  try {
    return new Date(timestamp).toLocaleString();
  } catch (e) {
    return html`<span class="text-muted">-</span>`;
  }
};

const renderLinks = (task) => {
  const token = task.token;
  const node = task.node;
  const nodeUrl = node ? buildNodeUrl(node, node.token) : null;
  const clusterInfoUrl = token ? buildClusterUrl("/info", token) : null;
  const clusterTaskListUrl = token ? buildClusterUrl("/task/list", token) : null;
  const taskInfoUrl = token ? buildClusterUrl(`/task/${encodeURIComponent(task.uuid)}/info`, token) : null;
  const taskOutputUrl = token
    ? buildClusterUrl(`/task/${encodeURIComponent(task.uuid)}/output`, token, { line: 0 })
    : null;

  return html`<div class="d-flex flex-wrap gap-1">
    ${nodeUrl
      ? html`<a class="btn btn-sm btn-outline-primary" href=${nodeUrl} target="_blank" rel="noopener noreferrer"
          >Node UI</a
        >`
      : html`<span class="text-muted">Node N/A</span>`}
    ${clusterInfoUrl
      ? html`<a
          class="btn btn-sm btn-outline-secondary"
          href=${clusterInfoUrl}
          target="_blank"
          rel="noopener noreferrer"
          >Cluster info</a
        >`
      : html``}
    ${clusterTaskListUrl
      ? html`<a
          class="btn btn-sm btn-outline-secondary"
          href=${clusterTaskListUrl}
          target="_blank"
          rel="noopener noreferrer"
          >Task list</a
        >`
      : html``}
    ${taskInfoUrl
      ? html`<a
          class="btn btn-sm btn-outline-success"
          href=${taskInfoUrl}
          target="_blank"
          rel="noopener noreferrer"
          >Task info</a
        >`
      : html``}
    ${taskOutputUrl
      ? html`<a
          class="btn btn-sm btn-outline-success"
          href=${taskOutputUrl}
          target="_blank"
          rel="noopener noreferrer"
          >Task output</a
        >`
      : html``}
  </div>`;
};

export const TaskList = ({ tasks = [] }) => {
  const hasTasks = Array.isArray(tasks) && tasks.length > 0;
  const sortedTasks = hasTasks ? [...tasks].sort((a, b) => (b.accessed || 0) - (a.accessed || 0)) : [];

  return html`<div class="mt-4">
    <h4>Registered Tasks</h4>
    ${hasTasks
      ? html`<table class="table table-hover table-striped">
          <thead>
            <tr class="text-white bg-secondary">
              <th>#</th>
              <th>UUID</th>
              <th>Token</th>
              <th>Node</th>
              <th>Status</th>
              <th>Last Activity</th>
              <th>Links</th>
            </tr>
          </thead>
          <tbody>
            ${sortedTasks.map(
              (task, idx) => html`<tr>
                <td>${idx + 1}</td>
                <td>
                  <span class="font-monospace" title=${task.uuid}>${task.uuid}</span>
                  ${task.source === "pending"
                    ? html`<div><span class="badge bg-secondary mt-1">Pending</span></div>`
                    : html``}
                </td>
                <td>${formatToken(task.token)}</td>
                <td>
                  ${task.node
                    ? html`<div>${task.node.name || `${task.node.hostname}:${task.node.port}`}</div>
                        <div class="text-muted small">${task.node.hostname}:${task.node.port}</div>
                        <div>
                          ${task.node.isOnline
                            ? html`<span class="badge bg-success">Online</span>`
                            : html`<span class="badge bg-danger">Offline</span>`}
                        </div>`
                    : html`<span class="text-muted">Unassigned</span>`}
                </td>
                <td>${formatStatus(task)}</td>
                <td>${formatTimestamp(task.accessed)}</td>
                <td>${renderLinks(task)}</td>
              </tr>`
            )}
          </tbody>
        </table>`
      : html`<p class="text-muted">No registered tasks.</p>`}
  </div>`;
};
