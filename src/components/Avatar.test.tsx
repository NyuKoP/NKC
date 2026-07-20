import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Avatar from "./Avatar";

const getBackgroundClass = (name: string, colorKey: string) => {
  const markup = renderToStaticMarkup(<Avatar name={name} colorKey={colorKey} />);
  return markup.match(/bg-\[#[0-9A-Fa-f]{6}\]/)?.[0];
};

describe("Avatar", () => {
  it("keeps the generated background color when the display name changes", () => {
    const before = getBackgroundClass("Original name", "stable-profile-id");
    const after = getBackgroundClass("Renamed profile", "stable-profile-id");

    expect(before).toBeTruthy();
    expect(after).toBe(before);
  });
});
