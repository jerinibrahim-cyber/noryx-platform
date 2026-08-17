import * as React from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Input } from "@noryx/ui-kit";
import styles from "./LoginScreen.module.css";

/**
 * Login screen. No real auth call yet — `handleSubmit` just logs the
 * submitted credentials (never the password itself) and navigates to the
 * dashboard, standing in for a future call to the platform's identity
 * service.
 */
export function LoginScreen() {
  const navigate = useNavigate();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | undefined>(undefined);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email || !password) {
      setError("Email and password are required.");
      return;
    }
    setError(undefined);
    // TODO: replace with a real call to the platform identity/auth service.
    // eslint-disable-next-line no-console
    console.log("[LoginScreen] submit", { email });
    navigate("/dashboard");
  }

  return (
    <div className={styles.page}>
      <Card title="Sign in to Noryx" className={styles.card}>
        <form onSubmit={handleSubmit} className={styles.form} noValidate>
          <Input
            label="Email"
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={error}
          />
          <Button type="submit" className={styles.submit}>
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}

export default LoginScreen;
