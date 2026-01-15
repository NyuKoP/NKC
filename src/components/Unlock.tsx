import { useState } from "react";
import { Upload } from "lucide-react";
import { wipeVault } from "../db/repo";

type UnlockProps = {
  onUnlock: (recoveryKey: string) => Promise<void>;
};

export default function Unlock({ onUnlock }: UnlockProps) {
  const [key, setKey] = useState("");

  const handleUpload = async (file: File) => {
    const text = await file.text();
    setKey(text.trim());
  };

  const handleReset = async () => {
    const ok = window.confirm(
      "로컬 금고를 초기화할까요? 복구키 없이는 복구할 수 없습니다."
    );
    if (!ok) return;
    await wipeVault();
    window.location.reload();
  };

  return (
    <div className="flex h-full items-center justify-center bg-nkc-bg px-6">
      <div className="w-full max-w-md rounded-nkc border border-nkc-border bg-nkc-panel p-8 shadow-soft">
        <h1 className="text-xl font-semibold">NKC 잠금 해제</h1>
        <p className="mt-2 text-sm text-nkc-muted">
          복구키를 입력해야 로컬 금고를 열 수 있습니다.
        </p>

        <label className="mt-6 text-sm">
          복구키
          <textarea
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className="mt-2 h-24 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
            placeholder="NKC-XXXX-XXXX-XXXX-XXXX"
          />
        </label>

        <label className="mt-3 flex cursor-pointer items-center gap-2 rounded-nkc border border-dashed border-nkc-border px-3 py-2 text-xs text-nkc-muted">
          <Upload size={14} />
          txt 파일 가져오기
          <input
            type="file"
            accept=".txt"
            className="hidden"
            onChange={(event) =>
              event.target.files?.[0] && handleUpload(event.target.files[0])
            }
          />
        </label>

        <button
          onClick={() => onUnlock(key)}
          className="mt-6 w-full rounded-nkc bg-nkc-accent px-4 py-3 text-sm font-semibold text-nkc-bg"
        >
          잠금 해제
        </button>
        <button
          onClick={handleReset}
          className="mt-3 w-full rounded-nkc border border-nkc-border px-4 py-2 text-xs text-nkc-muted hover:bg-nkc-panel"
        >
          금고 초기화하고 다시 시작
        </button>
      </div>
    </div>
  );
}