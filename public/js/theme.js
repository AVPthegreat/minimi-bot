// Light / dark: follows the system until the user picks one; the pick is remembered on this device.
import { ICONS } from "./icons.js";

const KEY = "minimi:theme";
const root = document.documentElement;
const system = () => (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");

export const currentTheme = () => root.dataset.theme || system();

function save(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

/** Wires the toggle button; keeps its icon and label right when the system theme changes. */
export function initTheme(button) {
  const paint = () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    button.innerHTML = next === "dark" ? ICONS.moon : ICONS.sun;
    button.setAttribute("aria-label", `Switch to ${next} theme`);
    button.title = `Switch to ${next} theme`;
  };
  button.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    root.classList.add("theme-switching");
    root.dataset.theme = next;
    save(next);
    paint();
    setTimeout(() => root.classList.remove("theme-switching"), 250);
  });
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", paint);
  paint();
}
