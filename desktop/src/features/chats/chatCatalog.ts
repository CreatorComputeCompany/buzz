import type { OrcaChatProvider } from "./chatChannel";

export type OrcaChatRepository = {
  baseRef: string;
  label: string;
  selector: string;
};

export const ORCA_CHAT_AGENT_PUBKEY =
  "dfe1fff34d276432bad703190b7152b4761c088157c8cd7513949dce5ebb84f0";

export const ORCA_CHAT_REPOSITORIES: OrcaChatRepository[] = [
  {
    baseRef: "feat/full-buzz-web",
    label: "Buzz",
    selector: "id:123b4e80-ef97-428b-b9d6-0bcc456f82ee",
  },
  {
    baseRef: "main",
    label: "Emma",
    selector: "id:a33a20c0-e67f-4f9a-85ec-be1859ba6116",
  },
  {
    baseRef: "main",
    label: "Emma Runtime",
    selector: "id:57fca5b3-1644-4a26-9327-06f6ac439a2e",
  },
  {
    baseRef: "main",
    label: "Emma Onboarding",
    selector: "id:357a7191-0573-4f4b-a60d-f9eaac636790",
  },
  {
    baseRef: "main",
    label: "List Engine",
    selector: "id:ecdfe907-dabd-495b-857a-38b833d0e033",
  },
];

export const ORCA_CHAT_PROVIDERS: Array<{
  label: string;
  value: OrcaChatProvider;
}> = [{ label: "Codex", value: "codex" }];
