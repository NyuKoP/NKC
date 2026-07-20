import type { ReactNode } from "react";

type AuthShellProps = {
  children: ReactNode;
  testId?: string;
};

export function NkcBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5" aria-label="NKC">
      <img
        src="./icon.png"
        alt=""
        className={`${compact ? "h-7 w-7" : "h-9 w-9"} shrink-0`}
        aria-hidden="true"
        draggable={false}
      />
      <span className={`${compact ? "text-lg" : "text-xl"} font-semibold tracking-[-0.02em]`}>
        NKC
      </span>
    </div>
  );
}

export default function AuthShell({ children, testId }: AuthShellProps) {
  return (
    <main className="nkc-auth-shell" data-testid={testId}>
      <div className="nkc-auth-brand">
        <NkcBrand />
      </div>
      <div className="nkc-auth-card animate-signal-fade-scale">{children}</div>
      <p className="nkc-auth-footer">개인 키는 이 기기에서 암호화되어 보관됩니다.</p>
    </main>
  );
}
