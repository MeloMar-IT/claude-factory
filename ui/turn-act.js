import { api } from "./api.js";
import { h, modal, mount, toast } from "./dom.js";

// The buttons and panels of Your turn that answer, approve, reject or retry an item. Every action is a normal
// comment on the issue (the server posts it); the panels only collect the text.

const SHOW = { questions: "Show questions", planner_questions: "Show questions", approve_plan: "Show plan", approve_split: "Show split", approval: "Show request" };
const FILLER = "Go with the recommendation.";

/** Buttons for an item with `acts`; `onAct(body)` posts and returns a promise. */
export function actButtons(item, onAct) {
  const kind = item.next.kind;
  const openDetail = async (title, build) => {
    let detail;
    try {
      detail = await api.turnDetail(item.key);
    } catch (e) {
      toast(e.message, "error");
      return;
    }
    modal(title, (close) => build(detail, close));
  };
  if (kind === "failed") {
    const retry = (btn) => {
      btn.disabled = true;
      onAct({ key: item.key, action: "retry" }).then(() => toast("Done — continuing"), (e) => { btn.disabled = false; toast(e.message, "error"); });
    };
    return [
      h("button", { class: "primary", onClick: (e) => retry(e?.currentTarget ?? e?.target ?? {}) }, "Retry"),
      h("button", { onClick: () => openDetail("Retry with a hint", (detail, close) => hintPanel({ ...item, stamp: detail.stamp }, { onAct, close })) }, "Retry with a hint…"),
    ];
  }
  const label = SHOW[kind];
  const questions = kind === "questions" || kind === "planner_questions";
  const build = (detail, close) => (questions ? questionsPanel : proposalPanel)(item, detail, { onAct, close });
  return label ? [h("button", { class: "primary", onClick: () => openDetail(label, build) }, label)] : [];
}

/** Posts `body`: the buttons are off meanwhile; on success the panel closes, on failure it stays open with the server's sentence. */
function submitter(buttons, onAct, close) {
  return async (body) => {
    for (const b of buttons) b.disabled = true;
    try {
      await onAct(body);
    } catch (e) {
      for (const b of buttons) b.disabled = false;
      toast(e.message, "error");
      return;
    }
    close();
    toast("Done — continuing");
  };
}

export function questionsPanel(item, detail, { onAct, close }) {
  const panel = h("div", { class: "turn-panel" });
  const questions = detail.questions ?? [];
  const show = () => {
    const buttons = [];
    const send = submitter(buttons, onAct, close);
    const mk = (props, label) => { const b = h("button", props, label); buttons.push(b); return b; };
    const actions = [];
    if ((detail.acts ?? []).includes("defaults")) actions.push(mk({ class: "primary", onClick: () => send({ key: item.key, action: "defaults", stamp: detail.stamp, digest: detail.digest }) }, "Accept all recommendations"));
    actions.push(mk({ onClick: form }, "Answer…"));
    mount(panel,
      questions.length
        ? questions.map((q) => h("div", { class: "turn-q" },
            h("b", {}, `Q${q.n}. ${q.title}`),
            q.text ? h("div", { class: "turn-text" }, q.text) : null,
            q.recommendation ? h("div", {}, `Recommendation: ${q.recommendation}`) : null))
        : h("pre", { class: "turn-text" }, detail.text ?? ""),
      h("div", { class: "row" }, ...actions, h("button", { onClick: () => close() }, "Close")));
  };
  const form = () => {
    const boxes = (questions.length ? questions : [{ title: "Your answer" }]).map((q) => ({
      q, box: h("textarea", { rows: 4, "aria-label": q.n === undefined ? "Your answer" : `Answer to Q${q.n}` }),
    }));
    const buttons = [];
    const send = submitter(buttons, onAct, close);
    const post = h("button", {
      class: "primary",
      onClick: () => {
        // Nothing is filled in for the user: every question needs its own answer (or a press on "Use recommendation").
        const answers = boxes.map(({ q, box }) => ({ n: q.n, text: String(box.value ?? "").trim() }));
        if (answers.some((a) => !a.text)) return toast(boxes.length > 1 ? "Answer every question" : "Write an answer", "error");
        send({ key: item.key, action: "answer", stamp: detail.stamp, digest: detail.digest, answers: answers.map((a) => (a.n === undefined ? { text: a.text } : a)) });
      },
    }, "Post answers");
    const back = h("button", { onClick: show }, "Back");
    buttons.push(post, back);
    mount(panel,
      ...boxes.map(({ q, box }) => h("label", { class: "turn-q" },
        h("b", {}, q.n === undefined ? q.title : `Q${q.n}. ${q.title}`),
        q.recommendation ? h("div", { class: "muted" }, `Recommendation: ${q.recommendation}`) : null,
        box,
        q.recommendation ? h("button", { class: "small", onClick: (e) => { e?.preventDefault?.(); box.value = FILLER; } }, "Use recommendation") : null)),
      h("div", { class: "row" }, post, back));
  };
  show();
  return panel;
}

export function proposalPanel(item, detail, { onAct, close }) {
  const p = detail.proposal ?? { text: detail.text ?? "" };
  const notes = h("textarea", { rows: 3, placeholder: "Notes — optional for Approve; for Reject, what to change", "aria-label": "Notes" });
  const buttons = [];
  const send = submitter(buttons, onAct, close);
  const approve = h("button", { class: "primary", onClick: () => send({ key: item.key, action: "approve", stamp: detail.stamp, digest: detail.digest, text: String(notes.value ?? "").trim() }) }, "Approve");
  const reject = h("button", {
    class: "danger",
    onClick: () => {
      const text = String(notes.value ?? "").trim();
      if (!text) return toast("Say what to change", "error");
      send({ key: item.key, action: "reject", stamp: detail.stamp, digest: detail.digest, text });
    },
  }, "Reject");
  const cancel = h("button", { onClick: () => close() }, "Cancel");
  buttons.push(approve, reject, cancel);
  const risk = p.risk === undefined ? null
    : h("div", { class: "turn-risk" }, p.split ? `Split risk: ${p.risk}/100` : `Risk: ${p.risk}/100${p.reason ? ` — ${p.reason}` : ""}`);
  return h("div", { class: "turn-panel" },
    risk,
    p.gate ? h("div", { class: "muted" }, `You decide: ${p.gate}`) : null,
    h("pre", { class: "turn-text" }, p.text ?? ""),
    notes,
    h("div", { class: "row" }, approve, reject, cancel));
}

export function hintPanel(item, { onAct, close }) {
  const hint = h("textarea", { rows: 4, placeholder: "What should it try differently?", "aria-label": "Hint" });
  const buttons = [];
  const send = submitter(buttons, onAct, close);
  const retry = h("button", {
    class: "primary",
    onClick: () => {
      const text = String(hint.value ?? "").trim();
      if (!text) return toast("Write the hint", "error");
      send({ key: item.key, action: "retry_hint", text, ...(item.stamp === undefined ? {} : { stamp: item.stamp }) });
    },
  }, "Retry");
  const cancel = h("button", { onClick: () => close() }, "Cancel");
  buttons.push(retry, cancel);
  return h("div", { class: "turn-panel" }, hint, h("div", { class: "row" }, retry, cancel));
}
