import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
const { RefreshButton, isRefreshShortcut } = await import("./refresh-button");

const press = (over: Partial<Parameters<typeof isRefreshShortcut>[0]> = {}) =>
  isRefreshShortcut({ key: "r", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: { tagName: "BODY" }, ...over });

describe("RefreshButton", () => {
  it("renders an idle button with its shortcut and the age of the data (PF-3.1, PF-3.5)", () => {
    const html = renderToStaticMarkup(<RefreshButton />);
    expect(html).toContain("Refresh");
    expect(html).toContain('aria-keyshortcuts="r"');
    expect(html).toContain('title="Refresh (r)"');
    expect(html).toContain("Updated just now");
    expect(html).not.toMatch(/ disabled=|aria-busy/);
    expect(html).not.toContain("data-spinner");
  });
});

describe("isRefreshShortcut", () => {
  it("accepts a bare r on the page", () => {
    expect(press()).toBe(true);
    expect(press({ target: { tagName: "BUTTON" } })).toBe(true);
  });
  it("ignores other keys, modifiers, repeats and composition", () => {
    expect(press({ key: "R", shiftKey: true })).toBe(false);
    expect(press({ key: "x" })).toBe(false);
    for (const m of ["metaKey", "ctrlKey", "altKey"] as const) expect(press({ [m]: true })).toBe(false);
    expect(press({ repeat: true })).toBe(false);
    expect(press({ isComposing: true })).toBe(false);
    expect(press({ defaultPrevented: true })).toBe(false);
  });
  it("ignores typing contexts (PF-3.4)", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(press({ target: { tagName } })).toBe(false);
    expect(press({ target: { tagName: "DIV", isContentEditable: true } })).toBe(false);
  });
});

describe("isRefreshShortcut ARIA widgets", () => {
  it("ignores role=textbox / role=combobox ancestors", () => {
    const inRole = { tagName: "DIV", closest: () => ({}) };
    expect(press({ target: inRole })).toBe(false);
  });
});
