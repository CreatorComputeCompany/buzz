import * as React from "react";
import { toast } from "sonner";

import { useRelayAgentsQuery } from "@/features/agents/hooks";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import type { OrcaChatConfig, OrcaChatProvider } from "./chatChannel";
import {
  ORCA_CHAT_AGENT_PUBKEY,
  ORCA_CHAT_PROVIDERS,
  ORCA_CHAT_REPOSITORIES,
} from "./chatCatalog";

const ORCA_AGENT_NAME = "Buzz Orca Agent";

export function NewChatDialog({
  onCreate,
  onOpenChange,
  open,
}: {
  onCreate: (config: OrcaChatConfig) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const agentsQuery = useRelayAgentsQuery({ enabled: open });
  const [repositorySelector, setRepositorySelector] = React.useState(
    ORCA_CHAT_REPOSITORIES[0]?.selector ?? "",
  );
  const [provider, setProvider] = React.useState<OrcaChatProvider>("codex");
  const [model, setModel] = React.useState("");
  const [isCreating, setIsCreating] = React.useState(false);
  const discoveredOrcaAgent = agentsQuery.data?.find(
    (agent) =>
      agent.name.trim().toLowerCase() === ORCA_AGENT_NAME.toLowerCase(),
  );
  const orcaAgentPubkey = discoveredOrcaAgent?.pubkey ?? ORCA_CHAT_AGENT_PUBKEY;

  const handleCreate = async () => {
    const repository = ORCA_CHAT_REPOSITORIES.find(
      (candidate) => candidate.selector === repositorySelector,
    );
    if (!repository) return;

    setIsCreating(true);
    try {
      const selectedModel = model.trim();
      await onCreate({
        agentPubkey: orcaAgentPubkey,
        baseRef: repository.baseRef,
        model: selectedModel || null,
        provider,
        repositoryLabel: repository.label,
        repositorySelector: repository.selector,
        title: selectedModel
          ? `${repository.label} · ${selectedModel}`
          : repository.label,
      });
      setModel("");
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not create the chat.",
      );
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New chat</DialogTitle>
          <DialogDescription>
            Start a disposable Orca worktree with your chosen repository and
            model.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <label className="grid gap-2 text-sm font-medium">
            Repository
            <select
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-hidden focus:ring-1 focus:ring-ring"
              data-testid="new-chat-repository"
              onChange={(event) => setRepositorySelector(event.target.value)}
              value={repositorySelector}
            >
              {ORCA_CHAT_REPOSITORIES.map((repository) => (
                <option key={repository.selector} value={repository.selector}>
                  {repository.label}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2 text-sm font-medium">
            Provider
            <select
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-hidden focus:ring-1 focus:ring-ring"
              data-testid="new-chat-provider"
              onChange={(event) =>
                setProvider(event.target.value as OrcaChatProvider)
              }
              value={provider}
            >
              {ORCA_CHAT_PROVIDERS.map((candidate) => (
                <option key={candidate.value} value={candidate.value}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2 text-sm font-medium">
            Model
            <Input
              data-testid="new-chat-model"
              onChange={(event) => setModel(event.target.value)}
              placeholder="Default model"
              value={model}
            />
            <span className="text-xs font-normal text-muted-foreground">
              Leave blank to use the provider default.
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            Cancel
          </Button>
          <Button
            data-testid="new-chat-create"
            disabled={isCreating}
            onClick={() => void handleCreate()}
          >
            {isCreating ? "Creating…" : "Create chat"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
