import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentationPage } from "./documentation-page.js";
import { DOCUMENTATION_SECTIONS, documentationText, filterDocumentation } from "./documentation-sections.js";

let resized: () => void;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe = vi.fn();
    disconnect = vi.fn();
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = DOCUMENTATION_SECTIONS.findIndex(section => section.id === this.id);
    const top = index < 0 ? 0 : 100 + index * 300 - (this.closest(".documentation-article")?.scrollTop ?? 0);
    return new DOMRect(0, top, 100, 100);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function owners() {
  return { navigation: screen.getByRole("navigation", { name: "Documentation navigation" }), article: screen.getByRole("region", { name: "Saturn operator guide" }) };
}
function current() { return screen.getAllByRole("button").filter(button => button.getAttribute("aria-current") === "location"); }

describe("Saturn operator documentation", () => {
  it("renders every current topic with unique target relationships and three groups", () => {
    render(<DocumentationPage />);
    const { navigation, article } = owners();
    expect(new Set(DOCUMENTATION_SECTIONS.map(section => section.id)).size).toBe(DOCUMENTATION_SECTIONS.length);
    for (const section of DOCUMENTATION_SECTIONS) {
      const destination = within(navigation).getByRole("button", { name: section.title });
      expect(destination.getAttribute("aria-controls")).toBe(section.id);
      expect(within(article).getByRole("heading", { name: section.title })).toBeTruthy();
      expect(document.getElementById(section.id)).toBeTruthy();
    }
    for (const group of ["Get Started", "Operate", "Maintain"]) expect(within(navigation).getByText(group)).toBeTruthy();
    expect(current()).toHaveLength(1);
    expect(current()[0]?.textContent).toBe("Introduction");
    expect(navigation.tabIndex).toBe(0);
    expect(article.tabIndex).toBe(0);
  });

  it.each([
    ["storage new", "guide-storage"], ["Window", "guide-host-backups"],
    ["Outdoor service tokens", "guide-pluto"], ["EXPORT_NOT_COMPLETED", "guide-pipelines"],
    ["Synchronize catalog", "guide-storage-connection"], ["Create snapshot", "guide-recovery"],
    ["regular-file symbolic links", "guide-pluto"], ["one-way", "guide-windows"],
  ])("finds the current operator term %s in real visible copy", (term, id) => {
    const section = DOCUMENTATION_SECTIONS.find(item => item.id === id);
    expect(section).toBeDefined();
    expect(`${section?.title ?? ""} ${section?.summary ?? ""} ${documentationText(section?.content)}`.toLowerCase()).toContain(term.toLowerCase());
    expect(filterDocumentation(`  ${term.toUpperCase()}  `).map(item => item.id)).toContain(id);
  });

  it("filters rendered body text immediately, preserves typed query and omits empty groups", () => {
    render(<DocumentationPage />);
    const input = screen.getByRole("searchbox", { name: "Search documentation" });
    fireEvent.change(input, { target: { value: "  DPAPI  " } });
    expect((input as HTMLInputElement).value).toBe("  DPAPI  ");
    expect(within(owners().navigation).getByRole("button", { name: "Neptune Windows" })).toBeTruthy();
    expect(screen.queryByText("Get Started")).toBeNull();
    expect(screen.queryByText("Maintain")).toBeNull();
    expect(current()).toHaveLength(1);
    expect(current()[0]?.textContent).toBe("Neptune Windows");
    expect(window.location.search).toBe("");
  });

  it("keeps search and workspace usable on no results, then clears with focus restoration", async () => {
    render(<DocumentationPage />);
    const input = screen.getByRole("searchbox", { name: "Search documentation" });
    const hiddenClear = document.querySelector<HTMLButtonElement>(".documentation-search-clear");
    expect(hiddenClear?.disabled).toBe(true);
    expect(hiddenClear?.tabIndex).toBe(-1);
    fireEvent.change(input, { target: { value: "this-has-no-matching-topic" } });
    expect(screen.getByRole("status").textContent).toContain("No documentation matches");
    expect(current()).toHaveLength(0);
    expect(owners().article).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect((input as HTMLInputElement).value).toBe("");
    expect(current()[0]?.textContent).toBe("Introduction");
  });

  it("Escape clears the complete query and deep article position without moving navigation", () => {
    render(<DocumentationPage />);
    const input = screen.getByRole("searchbox", { name: "Search documentation" });
    fireEvent.change(input, { target: { value: "Pluto" } });
    owners().article.scrollTop = 900;
    Object.defineProperty(owners().navigation, "scrollHeight", { configurable: true, value: 1000 });
    owners().navigation.scrollTop = 50;
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(owners().article.scrollTop).toBe(0);
    expect(owners().navigation.scrollTop).toBe(50);
    expect(document.activeElement).toBe(input);
  });

  it("navigates relative to article owner with a 30px reading offset and reduced motion", () => {
    render(<DocumentationPage />);
    const { article, navigation } = owners();
    const rect = (top: number) => ({ top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: top, toJSON: vi.fn() });
    article.getBoundingClientRect = vi.fn(() => rect(200));
    (document.getElementById("guide-pluto") as HTMLElement).getBoundingClientRect = vi.fn(() => rect(700));
    article.scrollTop = 100;
    const scrollTo = vi.fn();
    article.scrollTo = scrollTo;
    navigation.scrollTop = 40;
    fireEvent.click(within(navigation).getByRole("button", { name: "Pluto outdoor backups" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 570, behavior: "auto" });
    expect(navigation.scrollTop).toBe(40);
  });

  it("marks the final topic at maximum article scroll and resynchronizes after resize", () => {
    render(<DocumentationPage />);
    const { article, navigation } = owners();
    Object.defineProperties(article, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 } });
    article.scrollTop = 1600;
    navigation.scrollTop = 30;
    fireEvent.scroll(article);
    expect(current()).toHaveLength(1);
    expect(current()[0]?.textContent).toBe("Diagnostics and recovery checks");
    article.scrollTop = 0;
    fireEvent.scroll(article);
    resized();
    expect(current()[0]?.textContent).toBe("Introduction");
    expect(navigation.scrollTop).toBe(30);
  });
});
