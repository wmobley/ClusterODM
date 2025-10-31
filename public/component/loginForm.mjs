import { html } from "../lib/preact.html.mjs";
import { useState } from "../lib/hooks.module.js";

export const LoginForm = ({ onSubmit, error }) => {
  const [form, setForm] = useState({ username: "", password: "" });
  const [submitting, setSubmitting] = useState(false);

  const updateField = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    try {
      await onSubmit(form);
    } catch (err) {
      // Error message is handled upstream via props.error
    } finally {
      setSubmitting(false);
    }
  };

  return html`
    <div class="login-container">
      <form class="card p-4 shadow-sm login-card" onSubmit=${handleSubmit}>
        <h3 class="mb-3 text-center">ClusterODM Admin</h3>
        <p class="text-muted text-center">
          Sign in with your WebODM credentials to manage the cluster.
        </p>
        ${error
          ? html`<div class="alert alert-danger" role="alert">${error}</div>`
          : null}
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
        <button
          type="submit"
          class="btn btn-primary w-100"
          disabled=${submitting}
        >
          ${submitting ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </div>
  `;
};
