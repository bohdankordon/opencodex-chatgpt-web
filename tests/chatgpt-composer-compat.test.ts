import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_COMPOSER_ACCESSIBLE_NAME,
  CHATGPT_COMPOSER_SELECTOR,
  assertAuthenticatedChatGptPage,
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
  const effortButton: any = { last: () => effortButton, isVisible: async () => false };
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
