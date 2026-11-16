// Light / dark: light for everyone by default (the system preference is not followed); the user's pick is
// remembered on this device.
import { ICONS } from "./icons.js";

const KEY = "minimi:theme";
const root = document.documentElement;
export const currentTheme = () => (root.dataset.theme === "dark" ? "dark" : "light");

function save(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

/** Wires the toggle button and keeps its icon and label right. */
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
  paint();
}
