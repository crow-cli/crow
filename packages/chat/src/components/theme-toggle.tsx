import { CheckIcon, MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { THEMES, useTheme, type Theme } from "@/lib/theme";

const ICONS: Record<Theme, typeof SunIcon> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
  macchiato: PaletteIcon,
};

/**
 * The theme picker for a host that has no workbench to follow. `vscode.tsx`
 * derives light from dark off the body classes VS Code sets and observes them;
 * a browser page owns the choice, and `useTheme` already persists it under
 * `crow-chat.theme` and publishes `data-theme` plus the `dark` class on
 * `<html>`, which is what `themes/*.css` keys off.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const Icon = ICONS[theme];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-testid="theme-toggle"
          data-value={theme}
          aria-label={`Theme: ${theme}`}
          title={`Theme: ${theme}`}
          className="size-7 p-0"
        >
          <Icon aria-hidden className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="theme-menu">
        {THEMES.map((option) => {
          const OptionIcon = ICONS[option];
          return (
            <DropdownMenuItem
              key={option}
              data-testid="theme-option"
              data-value={option}
              onClick={() => setTheme(option)}
              className="gap-2 text-xs capitalize"
            >
              <OptionIcon aria-hidden className="size-3.5" />
              <span className="flex-1">{option}</span>
              {option === theme && <CheckIcon aria-hidden className="size-3.5" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
