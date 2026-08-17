import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "./theme-provider";
import { cssVar } from "./tokens";

describe("ThemeProvider", () => {
  it("applies no inline overrides when no `overrides` prop is given", () => {
    render(
      <ThemeProvider>
        <span data-testid="child">content</span>
      </ThemeProvider>,
    );
    const scope = screen.getByTestId("child").parentElement as HTMLElement;
    expect(scope.style.getPropertyValue(cssVar.colorPrimary)).toBe("");
  });

  it("applies a primaryColor override as the --noryx-color-primary CSS variable", () => {
    render(
      <ThemeProvider overrides={{ primaryColor: "#FF0000" }}>
        <span data-testid="child">content</span>
      </ThemeProvider>,
    );
    const scope = screen.getByTestId("child").parentElement as HTMLElement;
    expect(scope.style.getPropertyValue(cssVar.colorPrimary)).toBe("#FF0000");
  });

  it("applies accentColor and logoUrl overrides independently", () => {
    render(
      <ThemeProvider
        overrides={{
          accentColor: "#00FF00",
          logoUrl: "https://cdn.example.com/logo.png",
        }}
      >
        <span data-testid="child">content</span>
      </ThemeProvider>,
    );
    const scope = screen.getByTestId("child").parentElement as HTMLElement;
    expect(scope.style.getPropertyValue(cssVar.colorAccent)).toBe("#00FF00");
    expect(scope.style.getPropertyValue(cssVar.logoUrl)).toBe(
      "url(https://cdn.example.com/logo.png)",
    );
    // secondary color was not overridden — no inline value set
    expect(scope.style.getPropertyValue(cssVar.colorSecondary)).toBe("");
  });
});
