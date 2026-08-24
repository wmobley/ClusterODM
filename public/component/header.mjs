import { html } from "../lib/preact.html.mjs";

export const Header = ({ info = {}, user = null, onSignOut = null }) => {
  const handleSignOut = (event) => {
    event.preventDefault();
    if (typeof onSignOut === "function") {
      onSignOut();
    }
  };

  return html`
    <header class="py-3">
      <div class="row flex-nowrap justify-content-between align-items-center">
        <div class="col-4 d-flex align-items-center">
          <h2 class="text-left mt-2 mb-2">${info.name || "ClusterODM"} ${info.version || ""}</h2>
        </div>

        <div class="col-4 text-center text-muted small">
          ${user
            ? html`Signed in as <strong>${user.username}</strong>`
            : html`&nbsp;`}
        </div>

        <div class="col-4 d-flex justify-content-end align-items-center">
          ${onSignOut
            ? html`<button class="btn btn-sm btn-outline-secondary" onClick=${handleSignOut}>
                <i class="bi bi-door-open-fill"></i>
                Sign out
              </button>`
            : null}
        </div>
      </div>
    </header>
  `;
};
