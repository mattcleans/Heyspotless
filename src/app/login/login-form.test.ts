import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoginForm } from "./login-form";

describe("password-first login", () => {
  it("offers saved-password sign-in and a clear first-password/reset path", () => {
    const html = renderToStaticMarkup(
      createElement(LoginForm, { next: "/cleaner" }),
    );
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain("Set or reset password");
    expect(html).toContain("Show password");
    expect(html).toContain("Use an email sign-in link instead");
    expect(html).not.toContain("Email me a sign-in link");
  });
});
