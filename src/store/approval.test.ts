import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "./index";

/**
 * Full access = ZCode's `fullAccess` permission option ("grant the agent full
 * access without further confirmation"), held as a persistent flag here.
 *
 * These assertions are the proof that the option actually changes the agent's
 * behaviour, not just the dialog's appearance.
 */
beforeEach(() => {
  useStore.setState({
    pendingApproval: null,
    settings: {
      ...useStore.getState().settings,
      autoAcceptPermissions: false,
      alwaysAllowTools: [],
      alwaysDenyTools: [],
    },
  });
});

describe("permission requests", () => {
  it("prompts and waits while full access is off", async () => {
    let settled: boolean | undefined;
    const request = useStore
      .getState()
      .requestApproval("run_command", { command: "npm test" })
      .then((v) => {
        settled = v;
        return v;
      });

    const pending = useStore.getState().pendingApproval;
    expect(pending).not.toBeNull();
    expect(pending?.tool).toBe("run_command");
    expect(pending?.args.command).toBe("npm test");
    expect(settled).toBeUndefined(); // still blocked on the user

    useStore.getState().answerApproval(pending!.id, "allowOnce");
    await expect(request).resolves.toBe(true);
    expect(useStore.getState().pendingApproval).toBeNull();
  });

  it("rejectOnce denies the command without enabling full access", async () => {
    const request = useStore.getState().requestApproval("run_command", { command: "npm test" });
    const pending = useStore.getState().pendingApproval!;

    useStore.getState().answerApproval(pending.id, "rejectOnce");

    await expect(request).resolves.toBe(false);
    expect(useStore.getState().settings.autoAcceptPermissions).toBe(false);
  });

  it("ignores an answer carrying a stale request id", async () => {
    const request = useStore.getState().requestApproval("run_command", { command: "npm test" });
    const pending = useStore.getState().pendingApproval!;

    useStore.getState().answerApproval("not-the-pending-id", "allowOnce");
    expect(useStore.getState().pendingApproval).not.toBeNull();

    useStore.getState().answerApproval(pending.id, "allowOnce");
    await expect(request).resolves.toBe(true);
  });
});

describe("Full access", () => {
  it("allowFullAccess grants this command and stops asking for the next one", async () => {
    const first = useStore.getState().requestApproval("run_command", { command: "npm test" });
    const pending = useStore.getState().pendingApproval!;

    useStore.getState().answerApproval(pending.id, "allowFullAccess");

    await expect(first).resolves.toBe(true);
    expect(useStore.getState().settings.autoAcceptPermissions).toBe(true);
    expect(useStore.getState().pendingApproval).toBeNull();

    // The point of the option: the following command runs without a prompt.
    await expect(
      useStore.getState().requestApproval("run_command", { command: "npm run build" }),
    ).resolves.toBe(true);
    expect(useStore.getState().pendingApproval).toBeNull();
  });

  it("setFullAccess is revocable and takes effect immediately", async () => {
    useStore.getState().setFullAccess(true);
    await expect(
      useStore.getState().requestApproval("run_command", { command: "npm test" }),
    ).resolves.toBe(true);
    expect(useStore.getState().pendingApproval).toBeNull();

    useStore.getState().setFullAccess(false);
    expect(useStore.getState().settings.autoAcceptPermissions).toBe(false);

    // Revoked: the next request goes back to prompting.
    const request = useStore.getState().requestApproval("run_command", { command: "npm test" });
    expect(useStore.getState().pendingApproval).not.toBeNull();
    useStore.getState().answerApproval(useStore.getState().pendingApproval!.id, "allowOnce");
    await expect(request).resolves.toBe(true);
  });

  it("stopping the agent releases a pending prompt instead of hanging", async () => {
    const request = useStore.getState().requestApproval("run_command", { command: "npm test" });
    expect(useStore.getState().pendingApproval).not.toBeNull();

    useStore.getState().stopAgent();

    await expect(request).resolves.toBe(false);
    expect(useStore.getState().pendingApproval).toBeNull();
  });

  it("covers write_file too, not just shell commands", async () => {
    // "Toàn quyền" has to mean every tool. The gate used to sit only in the
    // run_command branch, so with full access on, the flag looked right while
    // the one tool that rewrites the user's files went through it untouched.
    useStore.getState().setFullAccess(true);
    await expect(
      useStore.getState().requestApproval("write_file", { path: "src/a.ts", content: "x" })
    ).resolves.toBe(true);
    expect(useStore.getState().pendingApproval).toBeNull();
  });
});

/**
 * The scoped rules ZCode installs through `permissionUpdates: addRules`.
 *
 * The deny rule outranking Full access is the safety property that makes the
 * whole feature trustworthy: "always block this tool" must survive the user
 * later turning the agent loose, or the option is a trapdoor.
 */
describe("always-allow and always-deny rules", () => {
  it("allowAlways stops asking for that tool but still asks about others", async () => {
    const first = useStore.getState().requestApproval("run_command", { command: "npm test" });
    useStore.getState().answerApproval(useStore.getState().pendingApproval!.id, "allowAlways");
    await expect(first).resolves.toBe(true);

    expect(useStore.getState().settings.alwaysAllowTools).toEqual(["run_command"]);
    // Same tool, no prompt.
    await expect(
      useStore.getState().requestApproval("run_command", { command: "npm run build" })
    ).resolves.toBe(true);
    expect(useStore.getState().pendingApproval).toBeNull();

    // A different tool still asks.
    const other = useStore.getState().requestApproval("write_file", { path: "a.ts" });
    expect(useStore.getState().pendingApproval).not.toBeNull();
    useStore.getState().answerApproval(useStore.getState().pendingApproval!.id, "rejectOnce");
    await expect(other).resolves.toBe(false);
  });

  it("rejectAlways blocks the tool without enabling full access", async () => {
    const first = useStore.getState().requestApproval("write_file", { path: "a.ts" });
    useStore.getState().answerApproval(useStore.getState().pendingApproval!.id, "rejectAlways");

    await expect(first).resolves.toBe(false);
    expect(useStore.getState().settings.alwaysDenyTools).toEqual(["write_file"]);
    expect(useStore.getState().settings.autoAcceptPermissions).toBe(false);

    // Blocked from then on, with no prompt.
    await expect(
      useStore.getState().requestApproval("write_file", { path: "b.ts" })
    ).resolves.toBe(false);
    expect(useStore.getState().pendingApproval).toBeNull();
  });

  it("a deny rule outranks Full access", async () => {
    useStore.getState().setFullAccess(true);
    useStore.getState().addAlwaysRule("write_file", "deny");

    // Full access says yes for everything; the explicit deny still wins.
    await expect(
      useStore.getState().requestApproval("write_file", { path: "a.ts", content: "x" })
    ).resolves.toBe(false);
    // ...while an unblocked tool is still allowed.
    await expect(
      useStore.getState().requestApproval("run_command", { command: "npm test" })
    ).resolves.toBe(true);
  });

  it("setting one behaviour clears the other, so a tool is never both", async () => {
    useStore.getState().addAlwaysRule("write_file", "deny");
    useStore.getState().addAlwaysRule("write_file", "allow");

    const s = useStore.getState().settings;
    expect(s.alwaysAllowTools).toEqual(["write_file"]);
    expect(s.alwaysDenyTools).toEqual([]);

    useStore.getState().addAlwaysRule("write_file", "deny");
    expect(useStore.getState().settings.alwaysAllowTools).toEqual([]);
    expect(useStore.getState().settings.alwaysDenyTools).toEqual(["write_file"]);
  });

  it("clearAlwaysRule removes both and the tool goes back to asking", async () => {
    useStore.getState().addAlwaysRule("run_command", "deny");
    useStore.getState().clearAlwaysRule("run_command");

    const s = useStore.getState().settings;
    expect(s.alwaysDenyTools).toEqual([]);
    const request = useStore.getState().requestApproval("run_command", { command: "npm test" });
    expect(useStore.getState().pendingApproval).not.toBeNull();
    useStore.getState().answerApproval(useStore.getState().pendingApproval!.id, "allowOnce");
    await expect(request).resolves.toBe(true);
  });
});
