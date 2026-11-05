import { afterEach, expect, test, vi } from "vitest";
import { render } from "@testing-library/react";
import { ToastProvider } from "@/components/toast";

vi.mock("next/font/google", () => ({
  Cormorant_Garamond: () => ({ variable: "--font-display" }),
  Inter: () => ({ variable: "--font-body" }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("layout metadata links the manifest, icons, and theme color", async () => {
  const { metadata, viewport } = await import("@/app/layout");
  expect(metadata.manifest).toBe("/manifest.webmanifest");
  expect(viewport.themeColor).toBe("#0B0B1F");
  expect(metadata.appleWebApp).toMatchObject({ capable: true, title: "Seventh House" });
  const icons = metadata.icons as { icon: unknown; apple: unknown };
  expect(JSON.stringify(icons.icon)).toContain("/icons/icon-192.png");
  expect(JSON.stringify(icons.apple)).toContain("/icons/apple-touch-icon.png");
});

test("RegisterSw renders nothing and does not register outside production", async () => {
  const { RegisterSw } = await import("@/components/register-sw");
  const register = vi.fn();
  vi.stubGlobal("navigator", { ...navigator, serviceWorker: { register, addEventListener() {} } });
  const { container } = render(
    <ToastProvider>
      <RegisterSw />
    </ToastProvider>,
  );
  // ToastProvider's own live region is the only thing in the tree
  expect(container.querySelectorAll("*:not([role=status])")).toHaveLength(0);
  expect(register).not.toHaveBeenCalled();
});

test("RegisterSw registers /sw.js in production and toasts on update", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const { RegisterSw } = await import("@/components/register-sw");

  const workerListeners: Record<string, () => void> = {};
  const installing = {
    state: "installing",
    addEventListener: (n: string, fn: () => void) => (workerListeners[n] = fn),
  };
  const regListeners: Record<string, () => void> = {};
  const registration = {
    installing,
    addEventListener: (n: string, fn: () => void) => (regListeners[n] = fn),
  };
  const register = vi.fn(() => Promise.resolve(registration));
  vi.stubGlobal("navigator", {
    ...navigator,
    serviceWorker: {
      register,
      controller: {}, // an existing worker controls the page → this is an update
      addEventListener() {},
      removeEventListener() {},
    },
  });

  const { findByText } = render(
    <ToastProvider>
      <RegisterSw />
    </ToastProvider>,
  );
  await vi.waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js"));
  await vi.waitFor(() => expect(regListeners.updatefound).toBeTypeOf("function"));
  regListeners.updatefound();
  installing.state = "installed";
  workerListeners.statechange();
  expect(await findByText(/Seventh House updated/)).toBeInTheDocument();
});
