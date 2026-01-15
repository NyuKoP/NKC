export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        nkc: {
          bg: "#f4f6f9",
          panel: "#ffffff",
          panelMuted: "#f7f8fb",
          card: "#eef1f6",
          text: "#1f2937",
          muted: "#6b7280",
          accent: "#3b82f6",
          danger: "#ef4444",
          border: "#e5e7eb",
        },
      },
      boxShadow: {
        soft: "0 12px 30px rgba(15, 23, 42, 0.12)",
      },
      borderRadius: {
        nkc: "16px",
      },
      maxWidth: {
        chat: "720px",
      },
    },
  },
  plugins: [],
};
