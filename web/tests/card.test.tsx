import { expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Card } from "@/components/card";

test("face-down shows the back; face-up reversed shows rotated alt text", () => {
  const { rerender, container } = render(<Card id="major-00-fool" faceUp={false} />);
  const imgs = container.querySelectorAll("img");
  expect(imgs[0]).toHaveAttribute("src", "/deck/back.webp");
  expect(imgs[0]).toHaveAttribute("alt", "");

  rerender(<Card id="major-00-fool" faceUp reversed />);
  const front = screen.getByAltText("The Fool, reversed");
  expect(front).toHaveAttribute("src", "/deck/major-00-fool.webp");
  expect(front.style.transform).toContain("rotate(180deg)");
});

test("upright front has no rotation", () => {
  render(<Card id="major-00-fool" faceUp />);
  expect(screen.getByAltText("The Fool, upright").style.transform).toBe("");
});

test("falls back to a text face when the image errors", () => {
  render(<Card id="major-00-fool" faceUp />);
  fireEvent.error(screen.getByAltText("The Fool, upright"));
  expect(screen.getByText("The Fool")).toBeInTheDocument();
});

test("button only when onFlip given and face-down", async () => {
  const onFlip = vi.fn();
  const { rerender } = render(<Card id="major-00-fool" faceUp={false} />);
  expect(screen.queryByRole("button")).toBeNull();

  rerender(<Card id="major-00-fool" faceUp={false} onFlip={onFlip} />);
  await userEvent.click(screen.getByRole("button", { name: "Reveal card" }));
  expect(onFlip).toHaveBeenCalledTimes(1);

  rerender(<Card id="major-00-fool" faceUp onFlip={onFlip} />);
  expect(screen.queryByRole("button")).toBeNull();
});

test("respects reduced motion", () => {
  const { container } = render(<Card id="major-00-fool" faceUp={false} />);
  expect(container.innerHTML).toContain("motion-reduce:transition-none");
});
