export function friendAddErrorMessage(error: string | undefined, language: "ko" | "en") {
  const t = (ko: string, en: string) => language === "ko" ? ko : en;

  if (error?.includes("Too many attempts")) {
    const seconds = error.match(/Try again in (\d+)s/)?.[1];

    return seconds ? t(`${seconds}초 후 다시 시도해 주세요.`, `Please try again in ${seconds}s.`)
      : t("잠시 후 다시 시도해 주세요.", "Please wait before trying again.");
  }

  if (error?.includes("yourself")) return t("자신의 코드는 추가할 수 없습니다. 친구의 코드를 입력하세요.", "You cannot add yourself. Enter your friend's code.");

  if (error?.includes("이미 친구 추가 요청")) return t("이미 친구 요청을 보냈습니다. 상대의 수락을 기다려 주세요.", "Request already sent. Wait for your friend to accept.");

  if (error?.includes("이미 추가된")) return t("이미 추가된 친구입니다.", "This friend is already added.");

  if (error?.includes("expired") || error?.includes("already used")) return t("사용할 수 없는 초대입니다. 친구에게 새 초대 코드를 요청하세요.", "This invitation is no longer usable. Ask your friend for a new code.");

  if (error && /invalid|prefix|checksum|code|레거시/i.test(error)) return t("친구에게 받은 NKC1- 또는 NKI1- 코드를 빠짐없이 붙여 넣어 주세요.", "Paste the complete NKC1- or NKI1- code from your friend.");

  return t("친구 추가에 실패했습니다. 코드를 확인하고 다시 시도해 주세요.", "Could not add this friend. Check the code and try again.");
}
