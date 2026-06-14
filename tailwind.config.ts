import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#1C1F3B",
          light: "#2C3057",
        },
        linen: "#F0EAD6",
        terracotta: {
          DEFAULT: "#C2714F",
          dark: "#A85D3F",
        },
        gold: "#C9A84C",
        cream: "#FAF7F2",
      },
      fontFamily: {
        heading: ["var(--font-heading)", "serif"],
        body: ["var(--font-body)", "sans-serif"],
        script: ["var(--font-script)", "cursive"],
      },
      keyframes: {
        "pulse-ring": {
          "0%": { boxShadow: "0 0 0 0 rgba(37, 211, 102, 0.55)" },
          "70%": { boxShadow: "0 0 0 12px rgba(37, 211, 102, 0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(37, 211, 102, 0)" },
        },
        unfold: {
          "0%": { clipPath: "inset(0 0 100% 0)", opacity: "0" },
          "100%": { clipPath: "inset(0 0 0% 0)", opacity: "1" },
        },
      },
      animation: {
        "pulse-ring": "pulse-ring 2.5s cubic-bezier(0.66, 0, 0, 1) infinite",
        unfold: "unfold 1.1s cubic-bezier(0.22, 1, 0.36, 1) forwards",
      },
      boxShadow: {
        soft: "0 4px 30px rgba(28, 31, 59, 0.08)",
        lift: "0 12px 40px rgba(28, 31, 59, 0.14)",
      },
    },
  },
  plugins: [],
};

export default config;
