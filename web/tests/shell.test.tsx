import { render, screen } from "@testing-library/react";
import { vi, test, expect } from "vitest";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";

vi.mock("next/navigation", () => ({ usePathname: () => "/chart/" }));

test("nav renders the six primary links with hrefs", () => {
  render(<Nav />);
  const expected: Record<string, string> = {
    Today: "/",
    Chart: "/chart/",
    Reading: "/reading/new/",
    Journal: "/journal/",
    Store: "/store/",
    Account: "/account/",
  };
  for (const [name, href] of Object.entries(expected))
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
});

test("nav marks the current route with aria-current", () => {
  render(<Nav />);
  expect(screen.getByRole("link", { name: "Chart" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "Today" })).not.toHaveAttribute("aria-current");
});

test("nav renders the right slot", () => {
  render(<Nav right={<span>pill</span>} />);
  expect(screen.getByText("pill")).toBeInTheDocument();
});

test("footer carries the disclaimer", () => {
  render(<Footer />);
  expect(screen.getByText(/not medical, legal, or financial advice/)).toBeInTheDocument();
  expect(screen.getByText(/© 2026 Nantasket Analytics, LLC/)).toBeInTheDocument();
});
