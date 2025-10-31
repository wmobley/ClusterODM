import { html } from "../lib/preact.html.mjs";

export const RefreshButton = ({ enabled = false, onChange = () => {}, disabled = false }) =>
  enabled
    ? html`<button
        class="btn btn-danger"
        disabled=${disabled}
        onClick=${() => onChange(false)}
      >
        Disable Auto Refresh
      </button>`
    : html`<button
        class="btn btn-success"
        disabled=${disabled}
        onClick=${() => onChange(true)}
      >
        Enable Auto Refresh
      </button>`;
