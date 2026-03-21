import { MoonStarIcon, SunMediumIcon } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = (resolvedTheme ?? "dark") === "dark";

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="min-w-24 gap-2 border-border/70 bg-background/70 backdrop-blur-sm"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <SunMediumIcon className="size-4" /> : <MoonStarIcon className="size-4" />}
      {isDark ? "Light" : "Dark"}
    </Button>
  );
}
