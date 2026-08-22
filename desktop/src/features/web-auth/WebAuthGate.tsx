import * as React from "react";
import { authClient } from "./authClient";
import "./web-auth.css";

export function WebAuthGate() {
  const [mode, setMode] = React.useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const result =
      mode === "sign-up"
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password });

    if (result.error) {
      setError(result.error.message ?? "Unable to sign in");
      setSubmitting(false);
      return;
    }
    window.location.reload();
  }

  return (
    <main className="web-auth-shell">
      <section className="web-auth-card">
        <div className="web-auth-mark" aria-hidden="true">
          ✦
        </div>
        <h1>Welcome to Buzz</h1>
        <p>
          {mode === "sign-in"
            ? "Sign in to your workspace."
            : "Create your workspace account."}
        </p>
        <form onSubmit={submit}>
          {mode === "sign-up" ? (
            <label>
              Name
              <input
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
          ) : null}
          <label>
            Email
            <input
              autoComplete="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              autoComplete={
                mode === "sign-in" ? "current-password" : "new-password"
              }
              minLength={10}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error ? <div className="web-auth-error">{error}</div> : null}
          <button type="submit" disabled={submitting}>
            {submitting
              ? "Please wait…"
              : mode === "sign-in"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>
        <button
          className="web-auth-switch"
          type="button"
          onClick={() => {
            setError(null);
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
          }}
        >
          {mode === "sign-in"
            ? "Create an account"
            : "Already have an account? Sign in"}
        </button>
      </section>
    </main>
  );
}
