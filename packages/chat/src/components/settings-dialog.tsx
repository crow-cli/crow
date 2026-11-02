import { useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { parseMcpConfig } from "@/lib/mcp-config";
import { cn } from "@/lib/utils";
import { PROTOCOLS, type WebProtocol, type WebSettings } from "@/lib/web-settings";

/**
 * The browser host's settings sheet — the editor half's counterpart to VS Code's
 * own settings UI, which `vscode.tsx` reaches by asking the extension to run
 * `workbench.action.openSettings`. A page has no workbench, so the four values
 * the extension injects (`endpoint`, `cwd`, `protocol`, `mcpConfig`) plus the
 * two the browser host adds (the conductor's endpoint, the board) are edited
 * here and land in localStorage through `saveSettings`.
 *
 * Saving is the caller's business: this component only produces the next
 * `WebSettings`, so the host decides what a change means (it remounts the
 * session, because a different endpoint is a different agent).
 */

const inputClass =
  "border-input bg-transparent focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-lg border px-2.5 py-1.5 text-sm outline-none focus-visible:ring-3 dark:bg-input/30";

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-foreground text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground text-[11px]">{hint}</span>}
    </label>
  );
}

function ProtocolPicker({ value, onChange }: { value: WebProtocol; onChange(next: WebProtocol): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid="protocol-picker" data-value={value} className="justify-between font-normal">
          <span>protocol {value}</span>
          <ChevronDownIcon aria-hidden className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as WebProtocol)}>
          {PROTOCOLS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} data-testid="protocol-option" className="gap-2 text-xs">
              <span className="flex-1">{option}</span>
              {option === value && <CheckIcon aria-hidden className="size-3.5" />}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Form({ settings, onSave }: { settings: WebSettings; onSave(next: WebSettings): void }) {
  const [draft, setDraft] = useState<WebSettings>(settings);
  const set = <K extends keyof WebSettings>(key: K, value: WebSettings[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  const mcp = parseMcpConfig(draft.mcpConfig);
  const endpointBad = draft.url !== "" && !draft.url.startsWith("ws://") && !draft.url.startsWith("wss://");
  const submit = () => {
    if (endpointBad || mcp.error) return;
    onSave(draft);
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field
        label="Agent endpoint"
        hint={endpointBad ? "must be a ws:// or wss:// URL" : "empty connects to whoever served this page"}
      >
        <input
          data-testid="setting-url"
          className={cn(inputClass, "font-mono text-xs", endpointBad && "border-destructive")}
          value={draft.url}
          spellCheck={false}
          aria-invalid={endpointBad || undefined}
          onChange={(event) => set("url", event.target.value)}
        />
      </Field>
      <Field label="Working directory" hint="the agent machine's path; empty leaves the agent its own default">
        <input
          data-testid="setting-cwd"
          className={cn(inputClass, "font-mono text-xs")}
          value={draft.cwd}
          spellCheck={false}
          onChange={(event) => set("cwd", event.target.value)}
        />
      </Field>
      <div className="flex items-end gap-3">
        <Field label="Protocol">
          <ProtocolPicker value={draft.protocol} onChange={(next) => set("protocol", next)} />
        </Field>
        <Field label="Board">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="setting-board"
            aria-pressed={draft.board}
            className="font-normal"
            onClick={() => set("board", !draft.board)}
          >
            {draft.board ? "shown" : "hidden"}
          </Button>
        </Field>
      </div>
      <Field label="Conductor endpoint" hint="the prompt-writing agent the loop talks to; empty disables the loop">
        <input
          data-testid="setting-conductor"
          className={cn(inputClass, "font-mono text-xs")}
          value={draft.conductorUrl}
          spellCheck={false}
          onChange={(event) => set("conductorUrl", event.target.value)}
        />
      </Field>
      <Field label="MCP servers" hint={mcp.error ? mcp.error : `${mcp.servers.length} server(s) handed to the agent at session/new`}>
        <Textarea
          data-testid="setting-mcp"
          rows={8}
          spellCheck={false}
          aria-invalid={mcp.error ? true : undefined}
          className={cn("font-mono text-xs", mcp.error && "border-destructive")}
          value={draft.mcpConfig}
          onChange={(event) => set("mcpConfig", event.target.value)}
        />
      </Field>
      <DialogFooter>
        <Button type="submit" data-testid="settings-save" disabled={endpointBad || Boolean(mcp.error)}>
          Save and reconnect
        </Button>
      </DialogFooter>
    </form>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  warnings,
  onSave,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  settings: WebSettings;
  warnings: readonly string[];
  onSave(next: WebSettings): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="settings-dialog">
        <DialogHeader>
          <DialogTitle>Crow settings</DialogTitle>
          <DialogDescription>
            Stored in this browser. Saved values that match the defaults are forgotten, so clearing a
            field really clears it.
          </DialogDescription>
        </DialogHeader>
        {warnings.length > 0 && (
          <ul className="bg-muted/50 text-muted-foreground rounded-md px-3 py-2 text-[11px]" data-testid="settings-warnings">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        {open && <Form settings={settings} onSave={onSave} />}
      </DialogContent>
    </Dialog>
  );
}
