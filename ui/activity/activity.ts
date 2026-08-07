/**
 * Message Operator activity card (shared by messageoperator_bash and messageoperator_view).
 *
 * Claude Desktop mounts app iframes only after the tool call completes and
 * replays toolinput/toolresult within ~50ms of mount (measured), so this is
 * a result card, not a live monitor: a brief branded bar-fill flourish on
 * fresh mounts, then the outcomes & alerts card built entirely from the
 * result's structuredContent. Rehydrated instances render the card
 * identically from the replayed result.
 *
 * The card deliberately carries no static title, no timings, and no
 * "nothing happened" narration — the reply text already says all of that.
 * It speaks only when something changed, failed, or needs attention.
 *
 * Open dist/ui/activity.html with #demo, #demo-dark, or #demo-quiet for a
 * hostless design-review run.
 */

import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

type UiState = "connecting" | "done" | "failed" | "cancelled";

interface Chip {
  kind: string;
  text: string;
}

/** The slice of the server's ActivityStructured payload this card reads.
 * The server also ships seq/createdAt/endedAt/steps; the card ignores them. */
interface ActivityStructured {
  view?: string;
  tool?: string;
  ok?: boolean;
  detail?: string;
  exitCode?: number;
  outcomes?: Chip[];
  attachments?: { name: string; path: string }[];
  alerts?: Chip[];
  dryRun?: boolean;
}

const CHIP_CLASS: Record<string, string> = {
  sent: "sent",
  simulated: "simulated",
  rejected: "rejected",
  archived: "brand",
  unarchived: "brand",
  fetched: "brand",
  packed: "brand",
  draft: "brand",
  // a composed draft is staged in the room, not yet in the user's mail
  // client — it reads as pending, like `queued`, not as a finished action
  draft_local: "warn",
  login: "brand",
  more: "muted",
  dry_run: "warn",
  auth: "warn",
  queued: "warn",
  // broker advisories (restart-required, stranded drafts) are warnings
  notice: "warn",
};

const RESULT_WAIT_MS = 10_000;

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

const root = el("root");
const subtitle = el("subtitle");
const fill = el("fill");
const chipsEl = el("chips");
const attachmentsEl = el("attachments");
const alertsEl = el("alerts");
const summaryEl = el("summary");
const detailEl = el("detail");

let resultSeen = false;
let pollIntervalId: number | null = null;

function setState(next: UiState): void {
  root.dataset.state = next;
}

function chipNode(chip: Chip): HTMLElement {
  const span = document.createElement("span");
  span.className = `chip ${CHIP_CLASS[chip.kind] ?? "brand"}`;
  span.textContent = chip.text;
  span.title = chip.text;
  return span;
}

function renderCard(
  sc: ActivityStructured,
  isError: boolean,
  onOpenFile?: (path: string) => void,
): void {
  fill.style.width = "100%";
  const finish = (): void => {
    setState(isError ? "failed" : "done");
    detailEl.textContent = sc.detail ?? "";
    detailEl.hidden = !sc.detail;
    const outcomes = sc.outcomes ?? [];
    const alerts = sc.alerts ?? [];
    const badExit = typeof sc.exitCode === "number" && sc.exitCode !== 0;
    // failures and changes are worth a sentence; a quiet successful call
    // gets none (the reply text already narrates what happened)
    const summary = isError
      ? "The tool call returned an error — see the reply for details."
      : badExit
        ? `Command exited with code ${sc.exitCode} — see the reply for details.`
        : outcomes.length > 0
          ? `${outcomes.length} action${outcomes.length === 1 ? "" : "s"} completed.`
          : "";
    summaryEl.textContent = summary;
    summaryEl.hidden = summary === "";
    chipsEl.replaceChildren(...outcomes.map(chipNode));
    alertsEl.replaceChildren(...alerts.map(chipNode));

    const attachs = sc.attachments ?? [];
    attachmentsEl.replaceChildren(
      ...attachs.map((att) => {
        const btn = document.createElement("button");
        btn.className = "chip action";
        btn.textContent = `📄 Open ${att.name}`;
        btn.title = `Open ${att.name}`;
        if (onOpenFile) {
          btn.onclick = () => onOpenFile(att.path);
        }
        return btn;
      }),
    );
  };
  finish();
}

function renderCancelled(): void {
  setState("cancelled");
  detailEl.hidden = true;
  summaryEl.textContent = "The tool call was cancelled before it finished.";
  summaryEl.hidden = false;
  chipsEl.replaceChildren();
  attachmentsEl.replaceChildren();
  alertsEl.replaceChildren();
}

function applyCtx(ctx: Partial<McpUiHostContext> | undefined): void {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

async function main(): Promise<void> {
  const app = new App({ name: "messageoperator-activity", version: "1.0.0" });

  const handleToolInput = (p: unknown) => {
    const args = (p as { arguments?: Record<string, unknown> }).arguments;
    const description = args?.description;
    if (typeof description === "string" && description) {
      subtitle.textContent = description;
      subtitle.title = description; // full text on hover; the line ellipsizes
    }
    // Stream the bash command or path live
    if (args?.command && typeof args.command === "string") {
      detailEl.textContent = `$ ${args.command}`;
      detailEl.hidden = false;
    } else if (args?.path && typeof args.path === "string") {
      detailEl.textContent = `view ${args.path}`;
      detailEl.hidden = false;
    }
  };

  app.addEventListener("toolinput", handleToolInput);
  app.addEventListener("toolinputpartial", handleToolInput);

  app.addEventListener("toolresult", (p) => {
    resultSeen = true;
    if (pollIntervalId !== null) {
      window.clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
    const params = p as {
      structuredContent?: ActivityStructured;
      isError?: boolean;
    };
    const sc = params.structuredContent;
    renderCard(
      sc && sc.view === "activity" ? sc : {},
      Boolean(params.isError) || sc?.ok === false,
      (path: string) => {
        app
          .callServerTool({
            name: "messageoperator_open_file",
            arguments: { path },
          })
          .catch(() => {});
      },
    );
  });

  app.addEventListener("toolcancelled", () => {
    resultSeen = true;
    if (pollIntervalId !== null) {
      window.clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
    renderCancelled();
  });

  app.addEventListener("hostcontextchanged", (p) => {
    const raw = p as Record<string, unknown>;
    applyCtx((raw.hostContext ?? raw) as Partial<McpUiHostContext>);
  });

  await app.connect();
  applyCtx(app.getHostContext());

  // Polling for live status while executing
  const pollProgress = async () => {
    if (resultSeen) return;
    try {
      const res = await app.callServerTool({
        name: "messageoperator_activity_progress",
        arguments: {},
      });
      if (resultSeen) return; // safety check after await
      const sc = res.structuredContent as Record<string, unknown> | undefined;
      if (sc && typeof sc.current === "string" && sc.current !== "idle") {
        summaryEl.textContent = sc.current + "...";
        summaryEl.hidden = false;
      }
    } catch (_err) {
      // Background tool might temporarily fail
    }
  };

  // Start polling
  pollProgress();
  pollIntervalId = window.setInterval(pollProgress, 500);

  // Safety net: if no result is replayed (unexpected host behavior), stop
  // shimmering and say so instead of spinning forever. Rendered directly —
  // renderCard would hide the summary for a result with no outcomes.
  window.setTimeout(() => {
    if (!resultSeen) {
      setState("done");
      summaryEl.textContent = "No activity data was delivered for this call.";
      summaryEl.hidden = false;
    }
  }, RESULT_WAIT_MS);
}

/**
 * Hostless design review: dist/ui/activity.html#demo or #demo-dark.
 * #demo-quiet shows a successful call with no outcomes (no summary line).
 */
async function demo(): Promise<void> {
  if (location.hash.includes("dark")) applyDocumentTheme("dark");
  const description = "Searching the inbox for unpaid invoices";
  subtitle.textContent = description;
  subtitle.title = description;
  await new Promise((r) => setTimeout(r, 1200)); // show the shimmer briefly
  if (location.hash.includes("quiet")) {
    renderCard(
      {
        view: "activity",
        tool: "messageoperator_bash",
        ok: true,
        detail: "$ mail search 'invoice' --limit 20",
        exitCode: 0,
        outcomes: [],
        alerts: [
          { kind: "dry_run", text: "Dry run is on — sends are simulated" },
        ],
      },
      false,
    );
    return;
  }
  renderCard(
    {
      view: "activity",
      tool: "messageoperator_bash",
      ok: true,
      detail: "$ mail search 'invoice' --limit 20",
      exitCode: 0,
      outcomes: [
        { kind: "sent", text: "Sent to legal@partner.example" },
        { kind: "simulated", text: "Simulated send to cfo@adeu.ai (dry run)" },
        { kind: "archived", text: "Archived 1748523.9ab2c3d4e5f6.eml" },
        { kind: "fetched", text: "Downloaded body gm:18f2a" },
        { kind: "rejected", text: "Send rejected — recipient_not_allowed" },
      ],
      attachments: [
        { name: "contract_v2.docx", path: "attachments/123/contract_v2.docx" },
        {
          name: "Q3_Financials.xlsx",
          path: "attachments/123/Q3_Financials.xlsx",
        },
      ],
      alerts: [
        { kind: "dry_run", text: "Dry run is on — sends are simulated" },
        { kind: "auth", text: "uzair@outlook.com: needs login" },
      ],
    },
    false,
  );
}

if (location.hash.startsWith("#demo")) {
  void demo();
} else {
  void main().catch(() => {
    // connection failure: leave the static shimmer; nothing useful to show
  });
}
