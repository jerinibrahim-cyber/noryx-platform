import * as React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ThemeProvider } from "@noryx/ui-kit";
import "@noryx/ui-kit/tokens.css";
import { App } from "./App";
import "./index.css";

// TODO(tenant-branding): once the Tenant Provisioning Service API is
// available, fetch the current tenant's branding record here and pass it
// as `overrides` to ThemeProvider — see packages/ui-kit/README.md.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider as="div" className="noryx-app-root">
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
