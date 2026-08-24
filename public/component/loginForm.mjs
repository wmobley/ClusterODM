import { html } from "../lib/preact.html.mjs";
import { useState, useMemo } from "../lib/hooks.module.js";

const DEFAULT_MODE = "tapis-jwt";

export const LoginForm = ({ onSubmit, error, mode, authConfig }) => {
  const [form, setForm] = useState({ username: "", password: "", token: "" });
  const [submitting, setSubmitting] = useState(false);

  const effectiveMode = useMemo(() => {
    if (!mode || mode === "loading" || mode === "unknown") {
      return DEFAULT_MODE;
    }
    return mode;
  }, [mode]);

  const tapisHints = useMemo(() => {
    const hints = [];
    const tapisConfig = authConfig && authConfig.tapisJwt ? authConfig.tapisJwt : null;
    if (tapisConfig) {
      if (Array.isArray(tapisConfig.allowedTenants) && tapisConfig.allowedTenants.length > 0) {
        hints.push(`Allowed tenants: ${tapisConfig.allowedTenants.join(", ")}`);
      }
      if (Array.isArray(tapisConfig.allowedUsers) && tapisConfig.allowedUsers.length > 0) {
        hints.push(`Allowed users: ${tapisConfig.allowedUsers.join(", ")}`);
      }
    }
    return hints;
  }, [authConfig]);

  const updateField = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    try {
      await onSubmit({ ...form, mode: effectiveMode });
    } catch (_err) {
      // Error message handled upstream
    } finally {
      setSubmitting(false);
    }
  };

  let description = "Authenticate to manage ClusterODM.";
  let fields = null;
  let showSubmit = true;
  let submitLabel = submitting ? "Signing in…" : "Sign In";

  if (effectiveMode === "tapis-jwt") {
    description = "Paste a valid Tapis JWT token to access the admin dashboard.";
    fields = html`
      <div class="mb-3">
        <label class="form-label" for="login-token">Tapis JWT Token</label>
        <textarea
          id="login-token"
          class="form-control"
          value=${form.token}
          onInput=${updateField("token")}
          rows="4"
          required
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
        ></textarea>
        <div class="form-text">
          The token is stored only for the duration of this session.
        </div>
      </div>
    `;
  } else if (effectiveMode === "webodm") {
    description = "Sign in with your WebODM credentials to manage the cluster.";
    fields = html`
      <div class="mb-3">
        <label class="form-label" for="login-username">Username</label>
        <input
          id="login-username"
          class="form-control"
          type="text"
          value=${form.username}
          onInput=${updateField("username")}
          autocomplete="username"
          required
        />
      </div>
      <div class="mb-3">
        <label class="form-label" for="login-password">Password</label>
        <input
          id="login-password"
          class="form-control"
          type="password"
          value=${form.password}
          onInput=${updateField("password")}
          autocomplete="current-password"
          required
        />
      </div>
    `;
  } else if (effectiveMode === "basic") {
    description =
      "This instance uses HTTP Basic authentication. Refresh the page and use your browser's login prompt.";
    showSubmit = false;
  } else {
    description = "Authentication is not configured for this instance.";
    showSubmit = false;
  }

  return html`
    <div class="login-container">
      <form class="card p-4 shadow-sm login-card" onSubmit=${handleSubmit}>
        <h3 class="mb-3 text-center">ClusterODM Admin</h3>
        <p class="text-muted text-center">${description}</p>
        ${effectiveMode === "tapis-jwt" && tapisHints.length > 0
          ? html`
              <ul class="small text-muted">
                ${tapisHints.map((hint) => html`<li>${hint}</li>`)}
              </ul>
            `
          : null}
        ${error
          ? html`<div class="alert alert-danger" role="alert">${error}</div>`
          : null}
        ${fields}
        ${showSubmit
          ? html`
              <button
                type="submit"
                class="btn btn-primary w-100"
                disabled=${submitting || mode === "loading"}
              >
                ${submitLabel}
              </button>
            `
          : html`
              <div class="alert alert-info" role="alert">
                Follow the on-screen instructions to authenticate.
              </div>
            `}
      </form>
    </div>
  `;
};
