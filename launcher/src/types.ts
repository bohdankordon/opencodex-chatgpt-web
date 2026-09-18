import languages from "../electron/languages.json";

export type Language = keyof typeof languages;
export type LauncherProfile = "production" | "development";
export type BrowserInteractionMode = "automatic" | "manual";
export type LauncherIntegrationMode = "direct" | "external-provider";

// Canonical read-only installation existence for first-install-only ownership
// intent (FINAL-A blocker fix). Computed by main/runtime at snapshot time from
// canonical runtime/setup config, never persisted into launcher-state.json and
// never renderer-settable. Missing means no canonical install, configured
// means a valid install exists, damaged means config exists but ownership
// cannot be safely proven. Readiness flags never decide this.
export type LauncherInstallationState = "missing" | "configured" | "damaged";

// G1 (PR #2): renderer protocol typing only. The main process resolves the
// canonical mode from runtime config; this value is never authority.
// Omitted during G1 for existing installs so main preserves canonical mode.
export interface IntegrationModeOption {
  integrationMode?: LauncherIntegrationMode;
}
export type Surface = "browser" | "setup" | "mcp" | "activity" | "settings";

export interface LauncherState {
  version: 1;
  language: Language | null;
  onboardingComplete: boolean;
  githubOpened: boolean;
  xOpened: boolean;
  autoStart: boolean;
  keepRunningOnClose: boolean;
  showBrowserDuringTurns: boolean;
  browserInteractionMode: BrowserInteractionMode;
  experimentalBiggerContext: boolean;
  experimentalSkillAttachments: boolean;
  zeroRiskProEnabled: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  browserSmokePassed?: boolean;
  browserSmokeVersion?: string | null;
  coreSetupComplete?: boolean;
  codexCatalogVerified?: boolean;
  mcpSetupComplete?: boolean;
  mcpRuntimeInstalled?: boolean;
  codexRestartRequired?: boolean;
  mcpGuideStep: number;
  sessionRefreshReminderAt: string | null;
}

export interface BrowserState {
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error";
  message: string;
  url: string;
  title: string;
  authenticated: boolean;
  visible: boolean;
  surfaceActive: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  activeTabId: string;
  maxTabs: number;
  tabs: BrowserTabState[];
}

export interface BrowserTabState {
  id: string;
  traceId: string | null;
  title: string;
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error" | "aborted";
  loading: boolean;
  active: boolean;
  closable: boolean;
  interactionMode?: BrowserInteractionMode;
  manualState?: "awaiting-user" | "sent" | "running" | "completed" | "timed-out" | "cancelled" | "failed";
  manualDeadlineAt?: string;
  canCopyPrompt?: boolean;
  canConfirmSent?: boolean;
}

export interface LogRecord {
  at: string;
  level: "debug" | "info" | "warning" | "error";
  event: string;
  detail: Record<string, unknown>;
}

export interface DoctorCheck {
  id: string;
  status: "ok" | "warning" | "error";
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: "browser-only" | "full";
  checks: DoctorCheck[];
}

export interface OperationState {
  name: string;
  status: "running" | "completed" | "failed";
  message: string;
}

export type UpdateState =
  | { status: "disabled" | "idle" | "checking" | "up-to-date" }
  | { status: "available" | "downloading" | "installing"; version: string }
  | { status: "error"; message: string };

export interface LauncherSnapshot {
  profile: LauncherProfile;
  profilePaths: {
    coreHome: string;
    codexHome: string;
    userData: string;
  };
  state: LauncherState;
  integrationInstallationState: LauncherInstallationState;
  browser: BrowserState | null;
  connectorName: string;
  connectorNames: Record<BrowserInteractionMode, string>;
  mcpCredentialsConfigured: boolean;
  logs: LogRecord[];
  urls: {
    github: string;
    x: string;
    connectors: string;
    tunnels: string;
    keys: string;
  };
  platform: string;
  packaged: boolean;
  version: string;
  smokePassed: boolean;
  operation: OperationState | null;
  update: UpdateState;
}

export interface LauncherApi {
  snapshot(): Promise<LauncherSnapshot>;
  setLanguage(language: Language): Promise<LauncherState>;
  openSocial(target: "github" | "x"): Promise<LauncherState>;
  completeOnboarding(language: Language, browserInteractionMode: BrowserInteractionMode): Promise<LauncherState>;
  openExternal(url: string): Promise<boolean>;
  setBrowserBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<boolean>;
  setBrowserSurfaceActive(active: boolean): Promise<BrowserState>;
  showBrowser(): Promise<BrowserState>;
  hideBrowser(): Promise<BrowserState>;
  navigateBrowser(action: "back" | "forward" | "reload"): Promise<BrowserState>;
  zoomBrowser(action: "in" | "out" | "reset"): Promise<BrowserState>;
  selectBrowserTab(tabId: string): Promise<BrowserState>;
  closeBrowserTab(tabId: string): Promise<BrowserState>;
  copyManualPrompt(tabId: string): Promise<BrowserState>;
  confirmManualSent(tabId: string): Promise<BrowserState>;
  openLogin(): Promise<BrowserState>;
  openPasskeyLogin(): Promise<BrowserState>;
  continuePasskeyLogin(): Promise<boolean>;
  logoutChatGpt(): Promise<{ browser: BrowserState; state: LauncherState }>;
  dismissSessionReminder(): Promise<LauncherState>;
  smokeTest(): Promise<{ ok: boolean; effort: string; response: string }>;
  verifyMcp(): Promise<DoctorReport>;
  doctor(): Promise<DoctorReport>;
  cancelTurns(): Promise<{ stdout: string }>;
  uninstallIntegration(): Promise<{ cancelled: true } | { cancelled: false; state: LauncherState }>;
  setupCore(input?: IntegrationModeOption): Promise<{ ok: boolean; stdout: string; restartRequired: boolean }>;
  setupMcp(input: {
    tunnelId?: string;
    runtimeKey?: string;
    replace?: boolean;
    interactionMode?: BrowserInteractionMode;
    integrationMode?: LauncherIntegrationMode;
  }): Promise<{ ok: boolean; stdout: string }>;
  setMcpStep(step: number): Promise<LauncherState>;
  setAutostart(enabled: boolean): Promise<{ state: LauncherState; supported: boolean; enabled: boolean }>;
  setBiggerContext(enabled: boolean, options?: IntegrationModeOption): Promise<LauncherState>;
  setSkillAttachments(enabled: boolean, options?: IntegrationModeOption): Promise<LauncherState>;
  setZeroRiskPro(enabled: boolean, options?: IntegrationModeOption): Promise<LauncherState>;
  setBrowserInteractionMode(mode: BrowserInteractionMode, options?: IntegrationModeOption): Promise<{
    state: LauncherState;
    credentialsRequired: boolean;
    targetMode: BrowserInteractionMode;
  }>;
  setPreference(
    key: "keepRunningOnClose" | "showBrowserDuringTurns",
    value: boolean,
  ): Promise<LauncherState>;
  setSidebarState(state: { open: boolean; width: number }): Promise<LauncherState>;
  logs(limit?: number): Promise<LogRecord[]>;
  exportLogs(): Promise<string | null>;
  installUpdate(): Promise<boolean>;
  windowState(): Promise<{ fullScreen: boolean; maximized: boolean }>;
  windowControl(action: "close" | "minimize" | "zoom"): void;
  onWindowStateChanged(listener: (state: { fullScreen: boolean; maximized: boolean }) => void): () => void;
  onStateChanged(listener: (state: LauncherState) => void): () => void;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onOperation(listener: (state: OperationState) => void): () => void;
  onLog(listener: (record: LogRecord) => void): () => void;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}

declare global {
  interface Window {
    codexWebLauncher?: LauncherApi;
  }
}
