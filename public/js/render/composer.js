// The floating input bar: grows with the text, Enter sends, Shift+Enter adds a line, and the send
// button becomes Stop while an answer streams.
import { ICONS } from "../icons.js";

const MAX = 4000;

export function initComposer({ form, input, button, count }, { onSend, onStop }) {
  let busy = false;

  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(220, input.scrollHeight)}px`;
    const n = input.value.length;
    count.textContent = n > MAX - 400 ? `${n} / ${MAX}` : "";
    button.disabled = !busy && !input.value.trim();
  };

  const paint = () => {
    button.innerHTML = busy ? ICONS.stop : ICONS.send;
    button.setAttribute("aria-label", busy ? "Stop answering" : "Send message");
    button.title = busy ? "Stop" : "Send (Enter)";
    button.classList.toggle("is-stop", busy);
    grow();
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) return onStop();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    grow();
    onSend(text);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy) form.requestSubmit();
    }
  });
  input.addEventListener("input", grow);
  if (matchMedia("(max-width: 560px)").matches) input.placeholder = "Ask minimi…";
  paint();

  return {
    setBusy(b) {
      busy = b;
      paint();
    },
    /** Puts an editable question in the box; `select` highlights the part to change. */
    fill(text, select) {
      input.value = text;
      grow();
      input.focus();
      const at = select ? text.indexOf(select) : -1;
      if (at >= 0) input.setSelectionRange(at, at + select.length);
      else input.setSelectionRange(text.length, text.length);
    },
    focus: () => input.focus({ preventScroll: true }),
  };
}
