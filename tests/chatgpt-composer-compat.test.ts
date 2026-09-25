import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_COMPOSER_ACCESSIBLE_NAME,
  CHATGPT_COMPOSER_SELECTOR,
  assertAuthenticatedChatGptPage,
  chatGptComposer,
  detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";

type Query = Array<string | undefined>;

function emptyScoped(): any {
  const self: any = {
    filter: () => self,
    first: () => self,
    last: () => self,
    or: (other: unknown) => other,
    count: async () => 0,
    nth: () => ({ isVisible: async () => false }),
    isVisible: async () => false,
    waitFor: async () => { throw new Error("never visible"); },
    locator: () => emptyScoped(),
    getByRole: () => emptyScoped(),
  };
  return self;
}

function composerPage(
  options: { semanticVisible: boolean; legacyVisible: boolean; queries?: Query[] },
) {
  const total = (options.semanticVisible ? 1 : 0) + (options.legacyVisible ? 1 : 0);
  const combined: any = {
    filter: () => combined,
    first: () => combined,
    last: () => combined,
    or: (other: unknown) => other,
    count: async () => total,
    nth: (index: number) => ({ isVisible: async () => index === 0 && total > 0 }),
    isVisible: async () => total > 0,
    waitFor: async ({ state }: { state: string }) => {
      if (state === "visible" && total > 0) return;
      throw new Error("never visible");
    },
    locator: () => emptyScoped(),
    getByRole: () => emptyScoped(),
  };
  const semanticBranch = { or: () => combined };
  const page: any = {
    getByRole: (role: string, opts?: { name?: string }) => {
      options.queries?.push(["getByRole", role, opts?.name]);
      if (role === "textbox" && opts?.name === CHATGPT_COMPOSER_ACCESSIBLE_NAME) return semanticBranch;
      return emptyScoped();
    },
    locator: (selector: string) => {
      options.queries?.push(["locator", selector]);
      return emptyScoped();
    },
  };
  return { page, combined, total };
}

function lunaCapablePage(options: { semanticVisible: boolean; legacyVisible: boolean }) {
  // The combined H6 + 6.1 probe scopes the effort control with a visible
  // filter instead of selecting .last(); the mock exposes both shapes.
  const effortButton: any = { last: () => effortButton, filter: () => effortButton, isVisible: async () => false };
  const composerForm: any = { count: async () => 1, locator: () => effortButton };
  const total = (options.semanticVisible ? 1 : 0) + (options.legacyVisible ? 1 : 0);
  const combined: any = {
    filter: () => combined,
    first: () => combined,
    last: () => combined,
    or: (other: unknown) => other,
    count: async () => total,
    nth: (index: number) => ({ isVisible: async () => index === 0 && total > 0 }),
    isVisible: async () => total > 0,
    waitFor: async ({ state }: { state: string }) => {
      if (state === "visible" && total > 0) return;
      throw new Error("never visible");
    },
    locator: () => composerForm,
    getByRole: () => emptyScoped(),
  };
  const semanticBranch = { or: () => combined };
  const page: any = {
    getByRole: (role: string, opts?: { name?: string }) => {
      if (role === "textbox" && opts?.name === CHATGPT_COMPOSER_ACCESSIBLE_NAME) return semanticBranch;
      return emptyScoped();
    },
    locator: () => combined,
    evaluate: async () => true,
  };
  return page;
}

test("semantic-only composer passes authentication without legacy CSS hooks", async () => {
  const { page } = composerPage({ semanticVisible: true, legacyVisible: false });
  await expect(assertAuthenticatedChatGptPage(page as never)).resolves.toBeUndefined();
});

test("legacy structural composer still passes authentication", async () => {
  const { page } = composerPage({ semanticVisible: false, legacyVisible: true });
  await expect(assertAuthenticatedChatGptPage(page as never)).resolves.toBeUndefined();
});

test("an unrelated Search textbox does not authenticate", async () => {
  const queries: Query[] = [];
  const { page } = composerPage({ semanticVisible: false, legacyVisible: false, queries });
  await expect(assertAuthenticatedChatGptPage(page as never)).rejects.toThrow(
    "no visible composer is present",
  );
  expect(queries).toContainEqual(["getByRole", "textbox", CHATGPT_COMPOSER_ACCESSIBLE_NAME]);
  expect(queries).toContainEqual(["locator", CHATGPT_COMPOSER_SELECTOR]);
  expect(queries.some(entry => entry.includes("Search"))).toBe(false);
});

test("login/auth and capability discovery share one composer contract", async () => {
  const authPage = lunaCapablePage({ semanticVisible: true, legacyVisible: false });
  await expect(assertAuthenticatedChatGptPage(authPage as never)).resolves.toBeUndefined();
  await expect(detectChatGptAccountCapabilities(authPage as never, {
    selectorTimeoutMs: 200,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, extraHighAvailable: false, proAvailable: false });

  const legacyPage = lunaCapablePage({ semanticVisible: false, legacyVisible: true });
  await expect(assertAuthenticatedChatGptPage(legacyPage as never)).resolves.toBeUndefined();
  await expect(detectChatGptAccountCapabilities(legacyPage as never, {
    selectorTimeoutMs: 200,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, extraHighAvailable: false, proAvailable: false });
});

test("browser runtime resolves the semantic-only composer through the shared contract", async () => {
  const total = 1;
  const combined: any = {
    filter: () => combined,
    first: () => combined,
    last: () => combined,
    or: (other: unknown) => other,
    count: async () => total,
    nth: (index: number) => ({ isVisible: async () => index === 0 }),
  };
  const page: any = {
    getByRole: (role: string, opts?: { name?: string }) => {
      expect(role).toBe("textbox");
      expect(opts?.name).toBe(CHATGPT_COMPOSER_ACCESSIBLE_NAME);
      return { or: () => combined };
    },
    locator: (selector: string) => {
      expect(selector).toBe(CHATGPT_COMPOSER_SELECTOR);
      return emptyScoped();
    },
  };
  const activeComposer = (ChatGptBrowserWorker.prototype as unknown as {
    activeComposer(page: unknown, timeoutMs?: number): Promise<unknown>;
  }).activeComposer;
  await expect(activeComposer.call({}, page, 500)).resolves.toBe(combined);
});

interface HiddenFirstElement {
  id: string;
  branch: "semantic" | "structural";
  visible: boolean;
  domIndex: number;
}

/**
 * Minimal deterministic stand-in for a Playwright Locator over the login
 * hidden-first fixture. It models exactly the semantics the regression
 * depends on and nothing else: `.or()` keeps the UNION of both branches
 * (never discards one), matches stay in DOM order, `.filter({ visible })`
 * keeps only visible matches, and `.first()` selects the DOM-first match.
 */
class HiddenFirstLocator {
  constructor(private readonly elements: HiddenFirstElement[]) {}

  or(other: HiddenFirstLocator): HiddenFirstLocator {
    const merged = [...this.elements, ...(other?.elements ?? [])];
    merged.sort((a, b) => a.domIndex - b.domIndex);
    const seen = new Set<string>();
    return new HiddenFirstLocator(merged.filter(element => {
      if (seen.has(element.id)) return false;
      seen.add(element.id);
      return true;
    }));
  }

  filter(options?: { visible?: boolean }): HiddenFirstLocator {
    if (options?.visible === true) {
      return new HiddenFirstLocator(this.elements.filter(element => element.visible));
    }
    return new HiddenFirstLocator([...this.elements]);
  }

  first(): HiddenFirstLocator {
    return new HiddenFirstLocator(this.elements.slice(0, 1));
  }

  ids(): string[] {
    return this.elements.map(element => element.id);
  }

  async count(): Promise<number> {
    return this.elements.length;
  }

  async isVisible(): Promise<boolean> {
    return this.elements.length > 0 && this.elements.every(element => element.visible);
  }

  async waitFor(options: { state: string; timeout?: number }): Promise<void> {
    if (options.state === "visible"
      && this.elements.length > 0
      && this.elements.every(element => element.visible)) return;
    throw new Error(
      "hidden-first fixture: locator is not visible (ids: " + (this.ids().join(",") || "empty") + ")",
    );
  }
}

function hiddenFirstComposerPage(): unknown {
  const elements: HiddenFirstElement[] = [
    { id: "semantic-hidden", branch: "semantic", visible: false, domIndex: 0 },
    { id: "structural-visible", branch: "structural", visible: true, domIndex: 1 },
  ];
  return {
    getByRole: (role: string, options?: { name?: string }) => {
      expect(role).toBe("textbox");
      expect(options?.name).toBe(CHATGPT_COMPOSER_ACCESSIBLE_NAME);
      return new HiddenFirstLocator(elements.filter(element => element.branch === "semantic"));
    },
    locator: (selector: string) => {
      expect(selector).toBe(CHATGPT_COMPOSER_SELECTOR);
      return new HiddenFirstLocator(elements.filter(element => element.branch === "structural"));
    },
  };
}

function hiddenFirstIds(locator: unknown): string[] {
  return (locator as unknown as HiddenFirstLocator).ids();
}

test("hidden semantic-first composer requires visible filtering before first()", async () => {
  const union = chatGptComposer(hiddenFirstComposerPage() as never);

  // The union preserves both branches in DOM order: the hidden semantic match first.
  await expect(union.count()).resolves.toBe(2);
  expect(hiddenFirstIds(union)).toEqual(["semantic-hidden", "structural-visible"]);

  // UNFILTERED: `.first()` binds the hidden DOM-first element, so a visible wait is invalid.
  const unfiltered = union.first();
  expect(hiddenFirstIds(unfiltered)).toEqual(["semantic-hidden"]);
  await expect(unfiltered.isVisible()).resolves.toBe(false);
  await expect(unfiltered.waitFor({ state: "visible", timeout: 50 })).rejects.toThrow("not visible");

  // FILTERED FIRST: visible filtering before `.first()` selects the visible structural composer.
  const filtered = union.filter({ visible: true }).first();
  expect(hiddenFirstIds(filtered)).toEqual(["structural-visible"]);
  await expect(filtered.isVisible()).resolves.toBe(true);
  await expect(filtered.waitFor({ state: "visible", timeout: 50 })).resolves.toBeUndefined();
});

test("browser-login binds the visible composer before first() at both call sites", () => {
  const source = readFileSync(join(import.meta.dir, "../src/browser-login.ts"), "utf8");
  const safeLookups = source.match(
    /chatGptComposer\(\w+\)\s*\.filter\(\{\s*visible:\s*true\s*\}\)\s*\.first\(\)/g,
  ) ?? [];
  expect(safeLookups).toHaveLength(2);
  expect(source).toContain("chatGptComposer(verifierPage)");
  expect(source).toContain("chatGptComposer(page)");
  const unfilteredFirst = source.match(/chatGptComposer\(\w+\)\s*\.first\(\)/g) ?? [];
  expect(unfilteredFirst).toEqual([]);
});
