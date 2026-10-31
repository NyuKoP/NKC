// A receipt requires an unobscured message inside the actual timeline viewport.
export const isMessageVisible = (target: HTMLElement, root: HTMLElement | null) => {
  const doc = target.ownerDocument;
  const view = doc.defaultView;

  if (!view || doc.visibilityState !== "visible" || !doc.hasFocus() || !target.isConnected) return false;
  const rect = target.getBoundingClientRect();
  const clip = root?.getBoundingClientRect();
  const left = Math.max(0, rect.left, clip?.left ?? 0);
  const top = Math.max(0, rect.top, clip?.top ?? 0);
  const right = Math.min(view.innerWidth, rect.right, clip?.right ?? view.innerWidth);
  const bottom = Math.min(view.innerHeight, rect.bottom, clip?.bottom ?? view.innerHeight);

  if (right <= left || bottom <= top) return false;
  const hit = doc.elementFromPoint((left + right) / 2, (top + bottom) / 2);

  return hit !== null && target.contains(hit);
};
