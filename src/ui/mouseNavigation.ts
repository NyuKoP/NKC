export const APP_BACK_EVENT = "nkc:navigate-back";

// Side-button navigation must not leave the SPA (or revisit the login route).
// Dispatch on pointer release only: preventing pointerdown suppresses the
// compatibility mouseup event in Chromium. Listening to both also risks two backs.
export function bindMouseNavigation(target: Window = window) {
  const handleMouse = (event: MouseEvent) => {
    if (event.button !== 3) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    if (event.type === "pointerup") target.dispatchEvent(new Event(APP_BACK_EVENT));
  };

  const events = ["pointerdown", "pointerup", "mousedown", "mouseup", "auxclick"] as const;

  for (const name of events) target.addEventListener(name, handleMouse, true);

  return () => {
    for (const name of events) target.removeEventListener(name, handleMouse, true);
  };
}
