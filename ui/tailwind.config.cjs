const path = require("node:path");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [path.join(__dirname, "index.html"), path.join(__dirname, "src/**/*.{svelte,ts}")],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        card: "hsl(var(--card) / <alpha-value>)",
        "card-foreground": "hsl(var(--card-foreground) / <alpha-value>)",
        muted: "hsl(var(--muted) / <alpha-value>)",
        "muted-foreground": "hsl(var(--muted-foreground) / <alpha-value>)",
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        primary: "hsl(var(--primary) / <alpha-value>)",
        "primary-foreground": "hsl(var(--primary-foreground) / <alpha-value>)",
        accent: "hsl(var(--accent) / <alpha-value>)",
        "accent-foreground": "hsl(var(--accent-foreground) / <alpha-value>)",
        success: "hsl(var(--success) / <alpha-value>)",
        warning: "hsl(var(--warning) / <alpha-value>)",
        destructive: "hsl(var(--destructive) / <alpha-value>)",
        info: "hsl(var(--info) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["'JetBrains Mono'", "'IBM Plex Mono'", "'SFMono-Regular'", "Menlo", "Monaco", "Consolas", "'Liberation Mono'", "monospace"],
        mono: ["'JetBrains Mono'", "'IBM Plex Mono'", "'SFMono-Regular'", "Menlo", "Monaco", "Consolas", "'Liberation Mono'", "monospace"],
      },
      boxShadow: {
        panel: "0 0 0 1px hsl(var(--border) / 1)",
      },
    },
  },
  plugins: [],
};
