module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        nkc: {
          bg: "var(--nkc-bg)",
          panel: "var(--nkc-panel)",
          panelMuted: "var(--nkc-panel-muted)",
          card: "var(--nkc-card)",
          text: "var(--nkc-text)",
          muted: "var(--nkc-muted)",
          accent: "var(--nkc-accent)",
          accentText: "var(--nkc-accent-text)",
          brandDeep: "var(--nkc-brand-deep)",
          brandPrimary: "var(--nkc-brand-primary)",
          brandAccent: "var(--nkc-brand-accent)",
          brandSecondary: "var(--nkc-brand-secondary)",
          brandSoft: "var(--nkc-brand-soft)",
          brandMist: "var(--nkc-brand-mist)",
          danger: "var(--nkc-danger)",
          border: "var(--nkc-border)",
          surface: "var(--nkc-surface)",
          hover: "var(--nkc-hover)",
          selected: "var(--nkc-selected)",
          bubbleSent: "var(--nkc-bubble-sent)",
          bubbleSentText: "var(--nkc-bubble-sent-text)",
          bubbleRecv: "var(--nkc-bubble-recv)",
          bubbleRecvText: "var(--nkc-bubble-recv-text)",
        },
      },
      boxShadow: {
        soft: "none",
      },
      borderRadius: {
        nkc: "8px",
        bubble: "18px",
      },
      maxWidth: {
        chat: "720px",
      },
    },
  },
  plugins: [],
};
